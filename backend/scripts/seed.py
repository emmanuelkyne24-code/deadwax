"""
Seed the database with the Deadwax catalog and an admin user.

Usage:
    ./venv/bin/python -m scripts.seed
"""
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.core.security import hash_password  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.models.record import Record  # noqa: E402
from app.models.user import User  # noqa: E402

RECORDS = [
    dict(catalog_number="DW-0001", title="Harmattan Suite", artist="Lena Osei", genre="Jazz",
         year=1978, price=28, stock=12, side_a=["Harmattan", "Dust Road"], side_b=["Coastal Drift", "Return"]),
    dict(catalog_number="DW-0002", title="Midnight Testimony", artist="The Vireo Quartet", genre="Jazz",
         year=1981, price=26, stock=9, side_a=["Testimony", "Low Light"], side_b=["Vireo", "Last Call"]),
    dict(catalog_number="DW-0003", title="Velvet Static", artist="Odessa Marsh", genre="Soul",
         year=1974, price=24, stock=15, side_a=["Velvet Static", "Slow Burn"], side_b=["Radio Silence", "Come Down Easy"]),
    dict(catalog_number="DW-0004", title="Slow Burn Radio", artist="Cassius Wren", genre="Soul",
         year=1976, price=24, stock=7, side_a=["Wren", "Static Heart"], side_b=["Radio Bird", "Fade To You"]),
    dict(catalog_number="DW-0005", title="Cumbia del Rio", artist="Los Hermanos Vega", genre="Latin",
         year=1983, price=30, stock=10, side_a=["Cumbia del Rio", "Puente Viejo"], side_b=["Noche de Feria", "Rio Abajo"]),
    dict(catalog_number="DW-0006", title="Noche Eterna", artist="Marisol Cruz", genre="Latin",
         year=1979, price=27, stock=0, side_a=["Noche Eterna", "Luna Llena"], side_b=["Sin Ti", "Amanecer"]),
    dict(catalog_number="DW-0007", title="Desert Modal", artist="Anadil Ensemble", genre="Global",
         year=1985, price=32, stock=6, side_a=["Desert Modal", "Caravan Line"], side_b=["Salt Flat", "Homebound"]),
    dict(catalog_number="DW-0008", title="Monsoon Static", artist="Kavi Rehman", genre="Global",
         year=1980, price=29, stock=11, side_a=["Monsoon Static", "First Rain"], side_b=["Ceiling Fan", "Late Bus"]),
]


def run():
    db = SessionLocal()
    try:
        for data in RECORDS:
            existing = db.query(Record).filter(Record.catalog_number == data["catalog_number"]).first()
            if existing:
                continue
            db.add(Record(**data))

        if not db.query(User).filter(User.email == "admin@deadwax.example").first():
            db.add(
                User(
                    email="admin@deadwax.example",
                    hashed_password=hash_password("change-this-password"),
                    full_name="Deadwax Admin",
                    is_admin=True,
                )
            )

        db.commit()
        print(f"Seeded {len(RECORDS)} records (skipping any that already existed) and ensured admin user exists.")
    finally:
        db.close()


if __name__ == "__main__":
    run()
