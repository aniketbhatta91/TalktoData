"""SQLite user database via SQLAlchemy.

Tables:
  users — registered users with role and approval status

The DB file is created at ./users.db relative to the backend working directory.
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = "sqlite:///./users.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="user")        # "user" | "admin"
    status = Column(String, default="pending")   # "pending" | "approved" | "rejected"
    created_at = Column(DateTime, default=datetime.utcnow)
    approved_at = Column(DateTime, nullable=True)


def create_tables():
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def seed_admin(email: str, name: str, password_hash: str):
    """Create the admin user if they don't exist yet."""
    email = email.lower().strip()   # normalise so signin always matches
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == email).first()
        if existing:
            # Ensure role + status are correct even if they signed up normally
            changed = False
            if existing.role != "admin":
                existing.role = "admin"; changed = True
            if existing.status != "approved":
                existing.status = "approved"
                existing.approved_at = datetime.utcnow(); changed = True
            if changed:
                db.commit()
                print(f"[AUTH] Admin role granted to existing user: {email}", flush=True)
            else:
                print(f"[AUTH] Admin already exists: {email}", flush=True)
            return
        admin = User(
            name=name,
            email=email,
            password_hash=password_hash,
            role="admin",
            status="approved",
            approved_at=datetime.utcnow(),
        )
        db.add(admin)
        db.commit()
        print(f"[AUTH] Admin user created: {email}", flush=True)
    except Exception as e:
        print(f"[AUTH] Error seeding admin: {e}", flush=True)
    finally:
        db.close()
