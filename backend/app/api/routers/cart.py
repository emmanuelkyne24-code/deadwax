import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.cart import CartItem
from app.models.record import Record
from app.models.user import User
from app.schemas.cart import CartItemAdd, CartItemUpdate, CartRead

router = APIRouter(prefix="/cart", tags=["cart"])


def _load_cart(db: Session, user_id) -> list[CartItem]:
    return (
        db.query(CartItem)
        .options(joinedload(CartItem.record))
        .filter(CartItem.user_id == user_id)
        .all()
    )


def _serialize(items: list[CartItem]) -> CartRead:
    subtotal = sum((item.record.price * item.quantity for item in items), start=0)
    return CartRead(items=items, subtotal=subtotal)


@router.get("", response_model=CartRead)
def get_cart(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _serialize(_load_cart(db, user.id))


@router.post("/items", response_model=CartRead, status_code=status.HTTP_201_CREATED)
def add_item(payload: CartItemAdd, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    record = db.get(Record, payload.record_id)
    if not record or not record.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")

    existing = (
        db.query(CartItem)
        .filter(CartItem.user_id == user.id, CartItem.record_id == payload.record_id)
        .first()
    )
    desired_qty = (existing.quantity if existing else 0) + payload.quantity
    if desired_qty > record.stock:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Only {record.stock} left of '{record.title}'",
        )

    if existing:
        existing.quantity = desired_qty
    else:
        db.add(CartItem(user_id=user.id, record_id=payload.record_id, quantity=payload.quantity))
    db.commit()
    return _serialize(_load_cart(db, user.id))


@router.patch("/items/{record_id}", response_model=CartRead)
def update_item(
    record_id: uuid.UUID,
    payload: CartItemUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = (
        db.query(CartItem)
        .filter(CartItem.user_id == user.id, CartItem.record_id == record_id)
        .first()
    )
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not in cart")
    if payload.quantity > item.record.stock:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Only {item.record.stock} left of '{item.record.title}'",
        )
    item.quantity = payload.quantity
    db.commit()
    return _serialize(_load_cart(db, user.id))


@router.delete("/items/{record_id}", response_model=CartRead)
def remove_item(record_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = (
        db.query(CartItem)
        .filter(CartItem.user_id == user.id, CartItem.record_id == record_id)
        .first()
    )
    if item:
        db.delete(item)
        db.commit()
    return _serialize(_load_cart(db, user.id))


@router.delete("", response_model=CartRead)
def clear_cart(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    db.query(CartItem).filter(CartItem.user_id == user.id).delete()
    db.commit()
    return _serialize([])
