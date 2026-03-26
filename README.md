# Quarterly Check-in Agent

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000

## Endpoints

- `POST /api/draft` - accepts form data and returns AI-generated check-in JSON
- `POST /api/pdf` - accepts the draft JSON and returns a PDF download
