-- Private Google OAuth credential storage. No browser-accessible RLS policy is created.

CREATE TABLE IF NOT EXISTS public.google_credentials (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.google_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.google_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.google_credentials TO service_role;

INSERT INTO public.google_credentials (user_id, access_token, refresh_token, updated_at)
SELECT id, google_access_token, google_refresh_token, NOW()
FROM public.users
WHERE google_access_token IS NOT NULL
ON CONFLICT (user_id) DO UPDATE SET
  access_token = EXCLUDED.access_token,
  refresh_token = COALESCE(EXCLUDED.refresh_token, public.google_credentials.refresh_token),
  updated_at = NOW();
