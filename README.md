# Conversational Data Analyst (with RAG)

Upload a CSV/Excel file, ask questions in natural language, and get statistical analysis,
outlier detection, sanity checks, and interactive Plotly charts. Ask **"why"** questions
(e.g. *"why did revenue dip?"*) and a RAG pipeline retrieves context from a ChromaDB
vector store to answer with grounded explanations.

## Architecture

```
React (Vite) ──HTTP──► FastAPI
                         ├── /api/upload/data   CSV/Excel → pandas profile (stats, IQR
                         │                      outliers, sanity checks) + auto-generated
                         │                      period summaries embedded into ChromaDB
                         ├── /api/upload/docs   PDF/DOCX/TXT → chunked → embedded (RAG)
                         └── /api/chat          Claude agent loop with two tools:
                               • run_python            pandas/plotly analysis on df
                               • search_knowledge_base ChromaDB semantic retrieval
```

The Claude agent decides per question: analytical requests run generated pandas/plotly
code against your dataframe; "why"/causal questions trigger vector retrieval first, then
answer grounded in the retrieved context (with source citations). Embeddings run locally
(all-MiniLM-L6-v2 via ChromaDB) — no extra API key needed.

## Setup

Requires Python 3.10+ and Node 18+.

### Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate        # Windows  (Linux/Mac: source venv/bin/activate)
pip install -r requirements.txt
copy .env.example .env       # then put your ANTHROPIC_API_KEY in .env
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev                  # opens http://localhost:5173
```

## Try it (sample data included)

1. Upload `sample_data/sales_data.csv` (button: **Upload CSV / Excel**).
2. Upload `sample_data/business_context_q4_2025.txt` (button: **Upload context docs**).
3. Ask:
   - "Show me revenue for the last two quarters as a chart"
   - "Run sanity checks and detect outliers"
   - "Do a full EDA with charts"
   - "Why did revenue dip in Q4 2025?" ← triggers the RAG pipeline

## Notes

- Sessions (dataframes) are in-memory; re-upload after restarting the backend.
- The vector DB persists in `backend/chroma_db/`. Delete that folder to reset the knowledge base.
- `run_python` executes model-generated code locally — fine for personal use; sandbox it
  (Docker, restricted exec) before exposing to other users.
- First doc upload downloads the local embedding model (~80 MB), so it takes a minute.
