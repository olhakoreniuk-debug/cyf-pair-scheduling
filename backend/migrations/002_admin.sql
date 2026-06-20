-- Admin account moderation and session cancellation.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status_changed_by UUID REFERENCES public.users(id);
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_account_status_check;
ALTER TABLE public.users ADD CONSTRAINT users_account_status_check CHECK (account_status IN ('active', 'deactivated', 'banned'));
ALTER TABLE public.slots ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE public.slots ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES public.users(id);
ALTER TABLE public.slots ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

CREATE OR REPLACE FUNCTION public.admin_set_user_status(
  p_admin_id UUID, p_user_id UUID, p_status TEXT, p_reason TEXT DEFAULT NULL
) RETURNS public.users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user public.users%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_admin_id AND role = 'admin' AND account_status = 'active') THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF p_admin_id = p_user_id THEN RAISE EXCEPTION 'cannot_change_own_status'; END IF;
  IF p_status NOT IN ('active', 'deactivated', 'banned') THEN RAISE EXCEPTION 'invalid_account_status'; END IF;
  UPDATE public.users SET account_status = p_status,
    status_reason = NULLIF(trim(COALESCE(p_reason, '')), ''), status_changed_at = NOW(), status_changed_by = p_admin_id
  WHERE id = p_user_id RETURNING * INTO v_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found'; END IF;
  RETURN v_user;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_cancel_slot(
  p_admin_id UUID, p_slot_id UUID, p_reason TEXT DEFAULT NULL
) RETURNS public.slots
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_slot public.slots%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_admin_id AND role = 'admin' AND account_status = 'active') THEN RAISE EXCEPTION 'admin_required'; END IF;
  SELECT * INTO v_slot FROM public.slots WHERE id = p_slot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'slot_not_found'; END IF;
  IF v_slot.status = 'cancelled' THEN RAISE EXCEPTION 'slot_already_cancelled'; END IF;
  UPDATE public.bookings SET status = 'cancelled', cancelled_by = 'admin',
    cancellation_reason = NULLIF(trim(COALESCE(p_reason, '')), ''), decided_at = NOW()
  WHERE slot_id = p_slot_id AND status IN ('pending', 'confirmed');
  UPDATE public.slots SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = p_admin_id,
    cancellation_reason = NULLIF(trim(COALESCE(p_reason, '')), '')
  WHERE id = p_slot_id RETURNING * INTO v_slot;
  RETURN v_slot;
END; $$;

REVOKE ALL ON FUNCTION public.admin_set_user_status(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_slot(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user_status(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_slot(UUID, UUID, TEXT) TO service_role;
