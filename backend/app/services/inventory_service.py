import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.record import Record


class InsufficientStockError(Exception):
    def __init__(self, record: Record, requested: int):
        self.record = record
        self.requested = requested
        super().__init__(f"Only {record.stock} left of '{record.title}', requested {requested}")


def check_availability(db: Session, cart_items: list) -> None:
    """Fail fast (before creating a Stripe session) if anything in the cart is oversold."""
    for item in cart_items:
        if item.quantity > item.record.stock or not item.record.is_active:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"'{item.record.title}' only has {item.record.stock} left in stock.",
            )


def decrement_stock_for_order(db: Session, order_items: list[dict]) -> None:
    """
    Locks each affected record row (SELECT ... FOR UPDATE) and decrements stock.
    Called from the Stripe webhook handler, inside a transaction, so concurrent
    fulfillments can't oversell the same copy.
    """
    for entry in order_items:
        record = db.execute(
            select(Record).where(Record.id == entry["record_id"]).with_for_update()
        ).scalar_one()
        if record.stock < entry["quantity"]:
            # Payment already succeeded on Stripe's side; we still record the
            # order but flag it so an operator can follow up / refund manually.
            raise InsufficientStockError(record, entry["quantity"])
        record.stock -= entry["quantity"]
