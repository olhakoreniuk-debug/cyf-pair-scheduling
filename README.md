# CYF Pair Scheduling

A calendar-based scheduling app for one-hour sessions between CodeYourFuture trainees and volunteers.

## How it works

1. Volunteers create Google Calendar events with `CYF` in the title.
2. The app syncs those events and displays available sessions in a calendar.
3. A trainee requests a session and submits an agenda.
4. The volunteer confirms or declines the request.
5. On confirmation, the trainee is invited to the Google event and receives a Google Meet link.
6. Administrators can moderate users, inspect bookings and cancel sessions.

## Technology

- React and Vite
- FastAPI
- Supabase Auth and PostgreSQL
- Google Calendar API and Google Meet

## Local development

Copy the example environment files and fill in the values without committing secrets.

Backend:

```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload
```

Frontend:

```powershell
cd frontend
npm install
npm run dev
```

The frontend runs at `http://localhost:5173` and the API documentation at `http://127.0.0.1:8000/docs`.

## Deployment

- Deploy the backend to Render using `render.yaml`.
- Deploy the `frontend` directory to Vercel.
- Set `VITE_API_URL` in Vercel to the Render API URL.
- Set `FRONTEND_URL` in Render to the Vercel frontend URL.
- Add the production frontend URL to Supabase Auth redirect URLs.
- Keep Supabase and Google secrets only in deployment environment variables.

Never commit `.env` files or service-role credentials.
