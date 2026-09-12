import stripe

from app.core.config import settings
from app.models.cart import CartItem

stripe.api_key = settings.STRIPE_SECRET_KEY


def create_checkout_session(order_id: str, user_email: str, cart_items: list[CartItem]) -> "stripe.checkout.Session":
    line_items = [
        {
            "price_data": {
                "currency": "usd",
                "product_data": {
                    "name": f"{item.record.title} \u2014 {item.record.artist}",
                    "metadata": {"record_id": str(item.record_id), "catalog_number": item.record.catalog_number},
                },
                # Stripe expects the smallest currency unit (cents).
                "unit_amount": int(item.record.price * 100),
            },
            "quantity": item.quantity,
        }
        for item in cart_items
    ]

    return stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card"],
        customer_email=user_email,
        line_items=line_items,
        success_url=settings.STRIPE_SUCCESS_URL,
        cancel_url=settings.STRIPE_CANCEL_URL,
        metadata={"order_id": order_id},
    )


def verify_webhook_signature(payload: bytes, sig_header: str) -> "stripe.Event":
    return stripe.Webhook.construct_event(payload, sig_header, settings.STRIPE_WEBHOOK_SECRET)
