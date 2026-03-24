# REACT Dashboard V3 - Local Setup Guide

This guide helps you run the project locally after cloning the repository.

## Project Structure

- `backend` - FastAPI API server
- `frontend` - React + Vite web app

## Prerequisites

Install these first:

- Python `3.10+`
- Node.js `18+` (or `20+`)
- npm (comes with Node.js)

## 1) Clone the Repository

```bash
git clone <your-repo-url>
cd "REACT Dashboard V3"
```

## 2) Backend Setup (FastAPI)

Open a terminal in `backend`:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create `backend/.env` with values like:

```env
# Data source: "mongodb" or "static"
DATA_SOURCE=mongodb

# Required when DATA_SOURCE=mongodb
MONGODB_URI=your_mongodb_connection_string

# Optional: comma-separated allowed frontend origins
CORS_ORIGINS=http://localhost:5173

# Optional: if you use Anthropic features
ANTHROPIC_API_KEY=your_key_here
ANTHROPIC_API_KEY_TEST=your_test_key_here
```

Start backend:

```bash
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

Backend will be available at `http://localhost:8080`.

## 3) Frontend Setup (React + Vite)

Open a second terminal in `frontend`:

```bash
cd frontend
npm install
```

Create `frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:8080
```

Start frontend:

```bash
npm run dev
```

Frontend will be available at `http://localhost:5173`.

## 4) Run Both Services

Keep both terminals running:

- Terminal 1: backend (`uvicorn ...`)
- Terminal 2: frontend (`npm run dev`)

## Common Issues

- Port already in use: change port in run command.
- CORS errors: set `CORS_ORIGINS` to include your frontend URL.
- API not reachable from frontend: verify `VITE_API_BASE_URL` points to backend.
