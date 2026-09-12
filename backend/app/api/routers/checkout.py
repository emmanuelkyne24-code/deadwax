import stripe
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.cart import CartItem
from app.models.order import Order, OrderItem, OrderStatus
from app.models.user import User
from app.schemas.order import CheckoutSessionResponse
from app.services import stripe_service
from app.services.inventory_service import check_availability

router = APIRouter(prefix="/checkout", tags=["checkout"])


@router.post("/session", response_model=CheckoutSessionResponse, status_code=status.HTTP_201_CREATED)
def create_checkout_session(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    cart_items = (
        db.query(CartItem)
        .options(joinedload(CartItem.record))
        .filter(CartItem.user_id == user.id)
        .all()
    )
    if not cart_items:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cart is empty")

    # Fail fast, before ever talking to Stripe, if anything is oversold.
    check_availability(db, cart_items)

    subtotal = sum((item.record.price * item.quantity for item in cart_items), start=0)

    order = Order(user_id=user.id, status=OrderStatus.pending, subtotal=subtotal)
    db.add(order)
    db.flush()  # populate order.id without committing yet

    for item in cart_items:
        db.add(
            OrderItem(
                order_id=order.id,
                record_id=item.record_id,
                title_snapshot=item.record.title,
                unit_price_snapshot=item.record.price,
                quantity=item.quantity,
            )
        )

    try:
        session = stripe_service.create_checkout_session(
            order_id=str(order.id), user_email=user.email, cart_items=cart_items
        )
    except stripe.error.StripeError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Stripe error: {exc}")

    order.stripe_checkout_session_id = session.id
    db.commit()

    return CheckoutSessionResponse(checkout_url=session.url, order_id=order.id)
