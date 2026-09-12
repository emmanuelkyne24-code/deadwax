from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routers import auth, cart, checkout, orders, records, users, webhooks
from app.core.config import settings

app = FastAPI(title=settings.PROJECT_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_private_network=True,
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(records.router)
app.include_router(cart.router)
app.include_router(checkout.router)
app.include_router(webhooks.router)
app.include_router(orders.router)


@app.get("/health", tags=["health"])
def health_check():
    return {"status": "ok"}
