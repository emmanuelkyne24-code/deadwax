import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.order import Order
from app.models.user import User
from app.schemas.order import OrderRead

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("", response_model=list[OrderRead])
def list_orders(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return (
        db.query(Order)
        .options(joinedload(Order.items))
        .filter(Order.user_id == user.id)
        .order_by(Order.created_at.desc())
        .all()
    )


@router.get("/{order_id}", response_model=OrderRead)
def get_order(order_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    order = (
        db.query(Order)
        .options(joinedload(Order.items))
        .filter(Order.id == order_id, Order.user_id == user.id)
        .first()
    )
    if not order:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    return order
