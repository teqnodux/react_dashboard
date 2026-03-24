# React Dashboard V3 - Project Flow

## Quick Answer: Is `data/` used?

Yes.

- `frontend/` does **not** directly read files from `data/`.
- `frontend/` calls backend APIs at `http://localhost:8000/api/...`.
- `backend/` reads from:
  - `backend/data/...` (pipeline outputs, timelines, settings, overrides, analysis artifacts)
  - root `data/...` (especially `data/deals.json`, `data/details/...`, and some docket inputs)

So the root `data/` folder is actively used by the backend, then exposed to frontend through API responses.

## High-Level Architecture

1. **Frontend (React + Vite)** in `frontend/`
   - Route/pages UI (`/tearsheet`, `/deal/:dealId`, `/all-regulatory`, etc.).
   - Fetches data from backend endpoints.
2. **Backend (FastAPI)** in `backend/main.py`
   - API layer + orchestration layer.
   - Loads/merges data from multiple JSON and generated sources.
3. **Data Layers**
   - **Root `data/`**: base deal universe and detail documents.
   - **`backend/data/`**: generated/derived artifacts and pipeline state.

## Runtime Request Flow

1. User opens frontend page (for example `PipelineTearsheet` or `DealDetail`).
2. Frontend issues `fetch()` to backend (`/api/deals`, `/api/deals/{id}`, `/api/deals/{id}/dma-timeline-data`, etc.).
3. Backend endpoint in `backend/main.py`:
   - loads core deal data (`data/deals.json` and related files),
   - reads deal-specific generated artifacts (`backend/data/...`),
   - merges/overlays tracking, regulatory, press-release, DMA extract, and other sources,
   - returns consolidated JSON.
4. Frontend renders cards/tables/charts from response.

## Where Root `data/` Is Used (Backend)

Important backend reads from root `data/` include:

- `data/deals.json` (core deals list and many update paths)
- `data/details/{deal_id}.json` (detail payload fallback/read path)
- `data/dockets/...` (docket conversion/output flows)

In the code, this is done with paths like:

- `Path(__file__).parent.parent / "data" / "deals.json"`
- `Path(__file__).parent.parent / "data" / "details" / f"{deal_id}.json"`

(`parent.parent` from `backend/main.py` points to project root.)

## Where `backend/data/` Is Used

Backend-local storage includes:

- `backend/data/timelines/...`
- `backend/data/press_release/...`
- `backend/data/dma_extract/...`
- `backend/data/reddit/...`
- `backend/data/mae/...`, `backend/data/covenants/...`, `backend/data/termination/...`
- `backend/data/deal_config/...`
- `backend/data/settings.json`, `backend/data/overrides/...`

These support pipeline processing, generated dashboards, monitor outputs, and user edits/overrides.

## Frontend Data Access Pattern

Frontend files (for example `frontend/src/pages/DealDetail.tsx`, `frontend/src/components/PipelineTable.tsx`) call:

- `GET /api/deals`
- `GET /api/deals/{dealId}`
- `GET /api/deals/{dealId}/dma-timeline-data`
- and many other `/api/...` endpoints

No direct file I/O to `data/` from frontend; all file-backed data access happens through backend APIs.

## Core Processing/Pipeline Flow

For a typical deal:

1. **Base record** comes from `data/deals.json`.
2. **Detail context** can come from `data/details/{deal_id}.json`.
3. **Document processors** (DMA/press release/SEC/proxy/etc.) generate extracted artifacts into `backend/data/...`.
4. **Timeline/regulatory/monitor endpoints** merge base + extracted + tracking + overrides at request time.
5. **Frontend** renders unified view and can trigger generation endpoints (which update files in `backend/data/...`).

## Practical Mental Model

- Think of root `data/` as **source-of-truth base datasets**.
- Think of `backend/data/` as **derived, enriched, and operational pipeline outputs**.
- Think of frontend as a **consumer of backend APIs only**.

## Optional Next Cleanup (Recommended)

If you want clearer maintenance, consider standardizing to one canonical data root (or documenting strict ownership):

- Option A: Keep both roots, but document exactly which folders are authoritative.
- Option B: Move root `data/` under `backend/data/` and update path references.
- Option C: Introduce environment-based data root variable and central path helpers.
