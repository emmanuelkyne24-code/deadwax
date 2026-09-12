import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import asc, desc, or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.record import Record
from app.models.user import User
from app.schemas.record import RecordCreate, RecordRead, RecordUpdate, StockAdjustment

router = APIRouter(prefix="/records", tags=["records"])

SORT_FIELDS = {
    "newest": desc(Record.year),
    "oldest": asc(Record.year),
    "price_asc": asc(Record.price),
    "price_desc": desc(Record.price),
}


@router.get("", response_model=list[RecordRead])
def list_records(
    db: Session = Depends(get_db),
    genre: str | None = Query(default=None),
    q: str | None = Query(default=None, description="Search title or artist"),
    sort: str = Query(default="newest", pattern="^(newest|oldest|price_asc|price_desc)$"),
    limit: int = Query(default=24, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    query = db.query(Record).filter(Record.is_active.is_(True))
    if genre and genre.lower() != "all":
        query = query.filter(Record.genre.ilike(genre))
    if q:
        like = f"%{q}%"
        query = query.filter(or_(Record.title.ilike(like), Record.artist.ilike(like)))
    query = query.order_by(SORT_FIELDS[sort])
    return query.offset(offset).limit(limit).all()


@router.get("/{record_id}", response_model=RecordRead)
def get_record(record_id: uuid.UUID, db: Session = Depends(get_db)):
    record = db.get(Record, record_id)
    if not record or not record.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")
    return record


# ---------------------------------------------------------------------------
# Admin-only management
# ---------------------------------------------------------------------------


@router.post("", response_model=RecordRead, status_code=status.HTTP_201_CREATED)
def create_record(
    payload: RecordCreate,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    if db.query(Record).filter(Record.catalog_number == payload.catalog_number).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Catalog number already exists")
    record = Record(**payload.model_dump())
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


@router.patch("/{record_id}", response_model=RecordRead)
def update_record(
    record_id: uuid.UUID,
    payload: RecordUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    record = db.get(Record, record_id)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(record, field, value)
    db.commit()
    db.refresh(record)
    return record


@router.post("/{record_id}/stock", response_model=RecordRead)
def adjust_stock(
    record_id: uuid.UUID,
    payload: StockAdjustment,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    record = db.get(Record, record_id)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")
    new_stock = record.stock + payload.delta
    if new_stock < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Adjustment would make stock negative")
    record.stock = new_stock
    db.commit()
    db.refresh(record)
    return record
