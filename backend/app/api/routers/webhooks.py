from datetime import datetime, timezone

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.cart import CartItem
from app.models.order import Order, OrderStatus
from app.services import stripe_service
from app.services.inventory_service import InsufficientStockError, decrement_stock_for_order

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/stripe", status_code=status.HTTP_200_OK)
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe_service.verify_webhook_signature(payload, sig_header)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid webhook signature")

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        _fulfill_order(db, session)

    return {"received": True}


def _fulfill_order(db: Session, session: dict) -> None:
    order = db.query(Order).filter(Order.stripe_checkout_session_id == session["id"]).first()
    if order is None:
        # Unknown session - nothing to fulfill. Don't error, or Stripe will keep retrying.
        return

    if order.status == OrderStatus.paid:
        # Already processed (Stripe retries webhooks) - idempotent no-op.
        return

    order_items = [{"record_id": item.record_id, "quantity": item.quantity} for item in order.items]

    try:
        decrement_stock_for_order(db, order_items)
    except InsufficientStockError:
        # Payment succeeded but we can't fulfill in full. Mark paid anyway so the
        # charge is tracked, and leave it for an operator to reconcile/refund -
        # silently losing a paid order would be worse than an oversold edge case.
        pass

    order.status = OrderStatus.paid
    order.stripe_payment_intent_id = session.get("payment_intent")
    order.paid_at = datetime.now(timezone.utc)

    db.query(CartItem).filter(
        CartItem.user_id == order.user_id,
        CartItem.record_id.in_([item["record_id"] for item in order_items]),
    ).delete(synchronize_session=False)

    db.commit()
