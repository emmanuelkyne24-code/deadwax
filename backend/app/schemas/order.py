import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict

from app.models.order import OrderStatus


class OrderItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    record_id: uuid.UUID
    title_snapshot: str
    unit_price_snapshot: Decimal
    quantity: int


class OrderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: OrderStatus
    subtotal: Decimal
    created_at: datetime
    paid_at: datetime | None
    items: list[OrderItemRead]


class CheckoutSessionResponse(BaseModel):
    checkout_url: str
    order_id: uuid.UUID
