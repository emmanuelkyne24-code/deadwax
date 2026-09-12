from types import SimpleNamespace

from app.models.order import Order, OrderStatus
from app.models.record import Record
from tests.conftest import auth_headers, register_user


class FakeStripeSession(SimpleNamespace):
    pass


def test_checkout_session_creates_pending_order(client, sample_record, monkeypatch, db_session):
    tokens = register_user(client)
    headers = auth_headers(tokens)
    client.post("/cart/items", json={"record_id": str(sample_record.id), "quantity": 2}, headers=headers)

    fake_session = FakeStripeSession(id="cs_test_123", url="https://checkout.stripe.com/pay/cs_test_123")

    def fake_create(order_id, user_email, cart_items):
        return fake_session

    monkeypatch.setattr("app.api.routers.checkout.stripe_service.create_checkout_session", fake_create)

    resp = client.post("/checkout/session", headers=headers)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["checkout_url"] == fake_session.url

    order = db_session.get(Order, body["order_id"])
    assert order.status == OrderStatus.pending
    assert order.stripe_checkout_session_id == "cs_test_123"
    assert len(order.items) == 1
    assert order.items[0].quantity == 2

    # Stock is not decremented until the webhook confirms payment.
    db_session.refresh(sample_record)
    assert sample_record.stock == 3


def test_checkout_rejects_when_cart_exceeds_stock(client, db_session, monkeypatch):
    record = Record(
        catalog_number="DW-TEST-2", title="Scarce Pressing", artist="Fixture Artist",
        genre="Soul", year=1975, price=20, stock=1, side_a=["A1"], side_b=["B1"],
    )
    db_session.add(record)
    db_session.commit()
    db_session.refresh(record)

    tokens = register_user(client, email="scarce@example.com")
    headers = auth_headers(tokens)
    client.post("/cart/items", json={"record_id": str(record.id), "quantity": 1}, headers=headers)

    # Simulate someone else buying the last copy after it was added to this cart.
    record.stock = 0
    db_session.commit()

    resp = client.post("/checkout/session", headers=headers)
    assert resp.status_code == 409


def test_webhook_fulfills_order_and_decrements_stock(client, sample_record, monkeypatch, db_session):
    tokens = register_user(client, email="fulfill@example.com")
    headers = auth_headers(tokens)
    client.post("/cart/items", json={"record_id": str(sample_record.id), "quantity": 2}, headers=headers)

    fake_session = FakeStripeSession(id="cs_test_456", url="https://checkout.stripe.com/pay/cs_test_456")
    monkeypatch.setattr(
        "app.api.routers.checkout.stripe_service.create_checkout_session",
        lambda order_id, user_email, cart_items: fake_session,
    )
    checkout_resp = client.post("/checkout/session", headers=headers)
    order_id = checkout_resp.json()["order_id"]

    fake_event = {
        "type": "checkout.session.completed",
        "data": {"object": {"id": "cs_test_456", "payment_intent": "pi_test_456"}},
    }
    monkeypatch.setattr(
        "app.api.routers.webhooks.stripe_service.verify_webhook_signature",
        lambda payload, sig_header: fake_event,
    )

    webhook_resp = client.post(
        "/webhooks/stripe", content=b"{}", headers={"stripe-signature": "fake"}
    )
    assert webhook_resp.status_code == 200

    order = db_session.get(Order, order_id)
    db_session.refresh(order)
    assert order.status == OrderStatus.paid
    assert order.stripe_payment_intent_id == "pi_test_456"

    db_session.refresh(sample_record)
    assert sample_record.stock == 1  # started at 3, bought 2

    # Cart should be cleared after fulfillment.
    cart_resp = client.get("/cart", headers=headers)
    assert cart_resp.json()["items"] == []


def test_webhook_is_idempotent_on_retry(client, sample_record, monkeypatch, db_session):
    tokens = register_user(client, email="retry@example.com")
    headers = auth_headers(tokens)
    client.post("/cart/items", json={"record_id": str(sample_record.id), "quantity": 1}, headers=headers)

    fake_session = FakeStripeSession(id="cs_test_789", url="https://checkout.stripe.com/pay/cs_test_789")
    monkeypatch.setattr(
        "app.api.routers.checkout.stripe_service.create_checkout_session",
        lambda order_id, user_email, cart_items: fake_session,
    )
    client.post("/checkout/session", headers=headers)

    fake_event = {
        "type": "checkout.session.completed",
        "data": {"object": {"id": "cs_test_789", "payment_intent": "pi_test_789"}},
    }
    monkeypatch.setattr(
        "app.api.routers.webhooks.stripe_service.verify_webhook_signature",
        lambda payload, sig_header: fake_event,
    )

    # Stripe retries webhooks; the handler must not double-decrement stock.
    client.post("/webhooks/stripe", content=b"{}", headers={"stripe-signature": "fake"})
    client.post("/webhooks/stripe", content=b"{}", headers={"stripe-signature": "fake"})

    db_session.refresh(sample_record)
    assert sample_record.stock == 2  # started at 3, bought 1, only once
