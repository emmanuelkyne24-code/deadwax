import uuid
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.record import RecordRead


class CartItemAdd(BaseModel):
    record_id: uuid.UUID
    quantity: int = Field(default=1, gt=0)


class CartItemUpdate(BaseModel):
    quantity: int = Field(gt=0)


class CartItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    record: RecordRead
    quantity: int


class CartRead(BaseModel):
    items: list[CartItemRead]
    subtotal: Decimal
