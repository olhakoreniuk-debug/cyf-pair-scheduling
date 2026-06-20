import os
from datetime import datetime, timezone
from typing import Annotated, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from supabase import create_client

from calendar_sync import (
    cancel_google_booking,
    confirm_google_booking,
    sync_volunteer_calendar,
)

load_dotenv()

app = FastAPI(title="CYF Pair Scheduling API", version="0.2.0")

allowed_origins = [
    origin.strip().rstrip("/")
    for origin in os.getenv("FRONTEND_URL", "http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY")
)


class BookingRequest(BaseModel):
    agenda: str = Field(default="", max_length=1000)


class BookingDecision(BaseModel):
    decision: Literal["confirmed", "declined"]


class AdminUserStatus(BaseModel):
    account_status: Literal["active", "deactivated", "banned"]
    reason: str = Field(default="", max_length=500)


class AdminCancellation(BaseModel):
    reason: str = Field(default="", max_length=500)


class GoogleCredentials(BaseModel):
    access_token: str = Field(min_length=1)
    refresh_token: str | None = None


def current_profile(
    authorization: Annotated[str | None, Header()] = None,
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing access token"
        )

    token = authorization.removeprefix("Bearer ").strip()
    try:
        auth_user = supabase.auth.get_user(token).user
        profile = supabase.table("users")\
            .select("id, email, name, role, account_status, min_booking_window_hours")\
            .eq("id", str(auth_user.id))\
            .single()\
            .execute().data
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token"
        ) from error

    if not profile:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User profile not found"
        )
    if profile.get("account_status", "active") != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is not active"
        )
    return profile


def booking_context(booking_id):
    try:
        booking = supabase.table("bookings")\
            .select("*")\
            .eq("id", booking_id)\
            .single()\
            .execute().data
        slot = supabase.table("slots")\
            .select("*")\
            .eq("id", booking["slot_id"])\
            .single()\
            .execute().data
        volunteer = supabase.table("users")\
            .select("*")\
            .eq("id", slot["volunteer_id"])\
            .single()\
            .execute().data
        trainee = supabase.table("users")\
            .select("id, email, name, role")\
            .eq("id", booking["trainee_id"])\
            .single()\
            .execute().data
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Booking not found"
        ) from error
    return booking, slot, volunteer, trainee


@app.get("/")
def root():
    return {"message": "CYF Pair Scheduling API is running"}


@app.get("/me")
def get_me(
    authorization: Annotated[str | None, Header()] = None,
):
    return current_profile(authorization)


@app.get("/slots")
def get_slots():
    response = supabase.table("slots")\
        .select("*, users!slots_volunteer_id_fkey(name, email)")\
        .eq("status", "available")\
        .execute()
    return response.data


@app.get("/my-slots")
def get_my_slots(
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] != "volunteer":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only volunteers can view their calendar"
        )

    response = supabase.table("slots")\
        .select("*")\
        .eq("volunteer_id", profile["id"])\
        .in_("status", ["available", "pending", "booked"])\
        .order("start_time")\
        .execute()
    return response.data


@app.post("/calendar/credentials", status_code=status.HTTP_204_NO_CONTENT)
def save_google_credentials(
    payload: GoogleCredentials,
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] != "volunteer":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only volunteers connect a calendar")

    existing = supabase.table("google_credentials")\
        .select("refresh_token")\
        .eq("user_id", profile["id"])\
        .execute().data
    refresh_token = payload.refresh_token or (existing[0].get("refresh_token") if existing else None)
    supabase.table("google_credentials").upsert({
        "user_id": profile["id"],
        "access_token": payload.access_token,
        "refresh_token": refresh_token,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="user_id").execute()


@app.post("/sync")
def sync_calendars(
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] not in ("volunteer", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Volunteer or admin access required")

    query = supabase.table("users").select("*").eq("role", "volunteer")
    if profile["role"] == "volunteer":
        query = query.eq("id", profile["id"])
    volunteers = query.execute()

    total = 0
    for volunteer in volunteers.data:
        total += sync_volunteer_calendar(supabase, volunteer)
    return {"synced_slots": total}


@app.post("/slots/{slot_id}/request", status_code=status.HTTP_201_CREATED)
def request_slot(
    slot_id: str,
    payload: BookingRequest,
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] not in ("trainee", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only trainees can request a session"
        )

    try:
        booking = supabase.rpc("request_booking", {
            "p_slot_id": slot_id,
            "p_trainee_id": profile["id"],
            "p_agenda": payload.agenda.strip(),
        }).execute().data
    except Exception as error:
        message = str(error)
        if "booking_window_closed" in message:
            detail = "This session is too soon to request"
        elif "slot_unavailable" in message:
            detail = "This session is no longer available"
        elif "agenda_too_long" in message:
            detail = "The agenda must be 1000 characters or fewer"
        else:
            detail = "The booking request could not be created"
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=detail
        ) from error

    return booking


@app.get("/bookings")
def get_bookings(
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    query = supabase.table("bookings").select("*")

    if profile["role"] == "trainee":
        bookings = query.eq("trainee_id", profile["id"])\
            .order("created_at", desc=True).execute().data
    elif profile["role"] == "volunteer":
        volunteer_slots = supabase.table("slots")\
            .select("id")\
            .eq("volunteer_id", profile["id"])\
            .execute().data
        slot_ids = [slot["id"] for slot in volunteer_slots]
        if not slot_ids:
            return []
        bookings = query.in_("slot_id", slot_ids)\
            .order("created_at", desc=True).execute().data
    elif profile["role"] == "admin":
        bookings = query.order("created_at", desc=True).execute().data
    else:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Unknown user role"
        )

    result = []
    for booking in bookings:
        _, slot, volunteer, trainee = booking_context(booking["id"])
        result.append({
            **booking,
            "slot": slot,
            "volunteer": {
                "id": volunteer["id"],
                "name": volunteer["name"],
                "email": volunteer["email"],
            },
            "trainee": trainee,
        })
    return result


@app.post("/bookings/{booking_id}/decision")
def decide_on_booking(
    booking_id: str,
    payload: BookingDecision,
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] not in ("volunteer", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the volunteer can decide on this request"
        )

    booking, slot, volunteer, trainee = booking_context(booking_id)
    if profile["role"] != "admin" and slot["volunteer_id"] != profile["id"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This request belongs to another volunteer"
        )
    if booking["status"] != "pending" or slot["status"] != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This request has already been decided"
        )

    meet_link = None
    if payload.decision == "confirmed":
        try:
            meet_link = confirm_google_booking(
                supabase=supabase,
                slot=slot,
                volunteer=volunteer,
                trainee=trainee,
                agenda=booking.get("agenda")
            )
        except Exception as error:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Google Calendar could not create the invite. The request is still pending."
            ) from error

    try:
        decided = supabase.rpc("decide_booking", {
            "p_booking_id": booking_id,
            "p_volunteer_id": slot["volunteer_id"],
            "p_decision": payload.decision,
        }).execute().data
        if meet_link:
            supabase.table("bookings")\
                .update({"google_meet_link": meet_link})\
                .eq("id", booking_id)\
                .execute()
            decided["google_meet_link"] = meet_link
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The request could not be updated"
        ) from error

    return decided


@app.get("/admin/users")
def admin_users(
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    return supabase.table("users")\
        .select("id, email, name, role, account_status, status_reason, status_changed_at, created_at")\
        .order("created_at", desc=True)\
        .execute().data


@app.get("/admin/slots")
def admin_slots(
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    return supabase.table("slots")\
        .select("*, users!slots_volunteer_id_fkey(name, email)")\
        .order("start_time")\
        .execute().data


@app.patch("/admin/users/{user_id}/status")
def admin_change_user_status(
    user_id: str,
    payload: AdminUserStatus,
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    try:
        return supabase.rpc("admin_set_user_status", {
            "p_admin_id": profile["id"],
            "p_user_id": user_id,
            "p_status": payload.account_status,
            "p_reason": payload.reason.strip(),
        }).execute().data
    except Exception as error:
        message = str(error)
        detail = "You cannot change your own status" if "cannot_change_own_status" in message else "User status could not be changed"
        raise HTTPException(status.HTTP_409_CONFLICT, detail) from error


@app.post("/admin/slots/{slot_id}/cancel")
def admin_cancel_session(
    slot_id: str,
    payload: AdminCancellation,
    authorization: Annotated[str | None, Header()] = None,
):
    profile = current_profile(authorization)
    if profile["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")

    try:
        slot = supabase.table("slots").select("*").eq("id", slot_id).single().execute().data
        volunteer = supabase.table("users").select("*").eq("id", slot["volunteer_id"]).single().execute().data
        active_bookings = supabase.table("bookings")\
            .select("*")\
            .eq("slot_id", slot_id)\
            .in_("status", ["pending", "confirmed"])\
            .execute().data
    except Exception as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Slot not found") from error

    confirmed = next((item for item in active_bookings if item["status"] == "confirmed"), None)
    if confirmed:
        trainee = supabase.table("users")\
            .select("id, email, name")\
            .eq("id", confirmed["trainee_id"])\
            .single()\
            .execute().data
        try:
            cancel_google_booking(supabase, slot, volunteer, trainee, payload.reason.strip())
        except Exception as error:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Google Calendar could not notify the trainee. Nothing was cancelled."
            ) from error

    try:
        return supabase.rpc("admin_cancel_slot", {
            "p_admin_id": profile["id"],
            "p_slot_id": slot_id,
            "p_reason": payload.reason.strip(),
        }).execute().data
    except Exception as error:
        raise HTTPException(status.HTTP_409_CONFLICT, "Slot could not be cancelled") from error
