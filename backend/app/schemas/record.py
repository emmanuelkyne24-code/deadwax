import uuid
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class RecordRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    catalog_number: str
    title: str
    artist: str
    genre: str
    year: int
    price: Decimal
    stock: int
    side_a: list[str]
    side_b: list[str]

    @property
    def in_stock(self) -> bool:
        return self.stock > 0


class RecordCreate(BaseModel):
    catalog_number: str
    title: str
    artist: str
    genre: str
    year: int
    price: Decimal = Field(gt=0)
    stock: int = Field(ge=0, default=0)
    side_a: list[str] = []
    side_b: list[str] = []


class RecordUpdate(BaseModel):
    title: str | None = None
    artist: str | None = None
    genre: str | None = None
    year: int | None = None
    price: Decimal | None = Field(default=None, gt=0)
    stock: int | None = Field(default=None, ge=0)
    is_active: bool | None = None


class StockAdjustment(BaseModel):
    delta: int  # positive to restock, negative to correct/write off
    reason: str
