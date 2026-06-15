# ---- Stage 1: build the React frontend ----
FROM node:20-slim AS frontend
WORKDIR /build
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Python backend serving API + built frontend ----
FROM python:3.11-slim
WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY --from=frontend /build/dist frontend/dist

# Hugging Face Spaces runs as non-root user 1000; make dirs writable
RUN mkdir -p /tmp/chroma_db && chmod -R 777 /tmp/chroma_db /app
ENV CHROMA_DB_PATH=/tmp/chroma_db
ENV HF_HOME=/tmp/hf_cache

WORKDIR /app/backend
EXPOSE 7860
# Use PORT env var if set (Render injects it), otherwise default to 7860
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-7860}"]
