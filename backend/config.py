import os
from dotenv import load_dotenv

load_dotenv()

# "anthropic" or "openai" (openai = any OpenAI-compatible API: Groq, Ollama, OpenRouter...)
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "anthropic").lower()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
ANTHROPIC_FAST_MODEL = os.getenv("ANTHROPIC_FAST_MODEL", "claude-haiku-4-5")

OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.groq.com/openai/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "llama-3.3-70b-versatile")
# small fast model used by the router/intent agent
OPENAI_FAST_MODEL = os.getenv("OPENAI_FAST_MODEL", "llama-3.1-8b-instant")

CHROMA_DB_PATH = os.getenv("CHROMA_DB_PATH", "./chroma_db")
MAX_AGENT_TURNS = 8

# ── Authentication ────────────────────────────────────────────────────────────
# Generate a strong random string for JWT_SECRET and add it to your .env
JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-production-please")

# Admin user seeded on startup (set both or neither)
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "")
ADMIN_NAME = os.getenv("ADMIN_NAME", "Admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
