from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import (
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.db.session import get_db
from app.models.user import RefreshToken, User
from app.schemas.auth import LoginRequest, RefreshRequest, RegisterRequest, TokenResponse

router = APIRouter(prefix="/auth", tags=["auth"])


def _issue_tokens(db: Session, user: User) -> TokenResponse:
    access_token = create_access_token(subject=str(user.id))
    raw_refresh, refresh_hash, expires_at = generate_refresh_token()
    db.add(RefreshToken(user_id=user.id, token_hash=refresh_hash, expires_at=expires_at))
    db.commit()
    return TokenResponse(access_token=access_token, refresh_token=raw_refresh)


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")

    user = User(
        email=payload.email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _issue_tokens(db, user)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is disabled")
    return _issue_tokens(db, user)


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)):
    token_hash = hash_token(payload.refresh_token)
    token_row = db.query(RefreshToken).filter(RefreshToken.token_hash == token_hash).first()

    invalid = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    if not token_row or token_row.revoked:
        raise invalid
    if token_row.expires_at < datetime.now(timezone.utc):
        raise invalid

    user = db.get(User, token_row.user_id)
    if not user or not user.is_active:
        raise invalid

    # Rotate: revoke the used refresh token and issue a fresh pair. This limits
    # the blast radius if a refresh token is ever stolen and replayed.
    token_row.revoked = True
    db.commit()
    return _issue_tokens(db, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(payload: RefreshRequest, db: Session = Depends(get_db)):
    token_hash = hash_token(payload.refresh_token)
    token_row = db.query(RefreshToken).filter(RefreshToken.token_hash == token_hash).first()
    if token_row:
        token_row.revoked = True
        db.commit()
    return None
