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
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == email).first()
        if existing:
            # Ensure role is admin in case they signed up normally first
            if existing.role != "admin":
                existing.role = "admin"
                existing.status = "approved"
                db.commit()
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
    finally:
        db.close()
