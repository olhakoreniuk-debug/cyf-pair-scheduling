-- Pending-booking workflow for CYF Pair Scheduling.
-- Run this file once in Supabase SQL Editor.

ALTER TABLE public.bookings
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

ALTER TABLE public.slots
  DROP CONSTRAINT IF EXISTS slots_status_check;

ALTER TABLE public.slots
  ADD CONSTRAINT slots_status_check
  CHECK (status IN ('available', 'pending', 'booked', 'cancelled'));

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_slot
  ON public.bookings (slot_id)
  WHERE status IN ('pending', 'confirmed');

CREATE OR REPLACE FUNCTION public.request_booking(
  p_slot_id UUID,
  p_trainee_id UUID,
  p_agenda TEXT DEFAULT ''
)
RETURNS public.bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot public.slots%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_min_window INTEGER;
BEGIN
  IF length(COALESCE(p_agenda, '')) > 1000 THEN
    RAISE EXCEPTION 'agenda_too_long';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_trainee_id AND role IN ('trainee', 'admin')
  ) THEN
    RAISE EXCEPTION 'trainee_not_found';
  END IF;

  SELECT * INTO v_slot
  FROM public.slots
  WHERE id = p_slot_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'slot_not_found';
  END IF;

  IF v_slot.status <> 'available' THEN
    RAISE EXCEPTION 'slot_unavailable';
  END IF;

  SELECT COALESCE(min_booking_window_hours, 24)
  INTO v_min_window
  FROM public.users
  WHERE id = v_slot.volunteer_id;

  IF v_slot.start_time <= NOW() + make_interval(hours => v_min_window) THEN
    RAISE EXCEPTION 'booking_window_closed';
  END IF;

  INSERT INTO public.bookings (slot_id, trainee_id, agenda, status)
  VALUES (p_slot_id, p_trainee_id, NULLIF(trim(p_agenda), ''), 'pending')
  RETURNING * INTO v_booking;

  UPDATE public.slots
  SET status = 'pending'
  WHERE id = p_slot_id;

  RETURN v_booking;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_booking(
  p_booking_id UUID,
  p_volunteer_id UUID,
  p_decision TEXT
)
RETURNS public.bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_slot public.slots%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('confirmed', 'declined') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;

  SELECT * INTO v_booking
  FROM public.bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;

  SELECT * INTO v_slot
  FROM public.slots
  WHERE id = v_booking.slot_id
  FOR UPDATE;

  IF v_slot.volunteer_id <> p_volunteer_id THEN
    RAISE EXCEPTION 'not_slot_volunteer';
  END IF;

  IF v_booking.status <> 'pending' OR v_slot.status <> 'pending' THEN
    RAISE EXCEPTION 'booking_not_pending';
  END IF;

  UPDATE public.bookings
  SET status = p_decision,
      decided_at = NOW()
  WHERE id = p_booking_id
  RETURNING * INTO v_booking;

  UPDATE public.slots
  SET status = CASE
    WHEN p_decision = 'confirmed' THEN 'booked'
    ELSE 'available'
  END
  WHERE id = v_booking.slot_id;

  RETURN v_booking;
END;
$$;

REVOKE ALL ON FUNCTION public.request_booking(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_booking(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.request_booking(UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.decide_booking(UUID, UUID, TEXT)
  TO service_role;
