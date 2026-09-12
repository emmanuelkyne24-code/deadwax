from tests.conftest import auth_headers, register_user


def test_list_records_filters_by_genre(client, sample_record):
    resp = client.get("/records", params={"genre": "Jazz"})
    assert resp.status_code == 200
    titles = [r["title"] for r in resp.json()]
    assert "Test Pressing" in titles

    resp_other = client.get("/records", params={"genre": "Soul"})
    assert "Test Pressing" not in [r["title"] for r in resp_other.json()]


def test_add_to_cart_and_get_cart(client, sample_record):
    tokens = register_user(client)
    resp = client.post(
        "/cart/items",
        json={"record_id": str(sample_record.id), "quantity": 2},
        headers=auth_headers(tokens),
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["subtotal"] == "50.00"
    assert body["items"][0]["quantity"] == 2


def test_cannot_add_more_than_stock(client, sample_record):
    tokens = register_user(client)
    resp = client.post(
        "/cart/items",
        json={"record_id": str(sample_record.id), "quantity": 999},
        headers=auth_headers(tokens),
    )
    assert resp.status_code == 409


def test_cart_quantity_accumulates_and_still_respects_stock(client, sample_record):
    tokens = register_user(client)
    headers = auth_headers(tokens)
    client.post("/cart/items", json={"record_id": str(sample_record.id), "quantity": 2}, headers=headers)
    # sample_record has stock=3, so 2 + 2 should be rejected.
    resp = client.post(
        "/cart/items", json={"record_id": str(sample_record.id), "quantity": 2}, headers=headers
    )
    assert resp.status_code == 409
