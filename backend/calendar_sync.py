from datetime import datetime, timedelta, timezone
import os
from uuid import uuid4

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build


def calendar_service(supabase, volunteer):
    rows = supabase.table('google_credentials')\
        .select('*')\
        .eq('user_id', volunteer['id'])\
        .execute().data
    if not rows:
        return None

    stored = rows[0]
    credentials = Credentials(
        token=stored.get('access_token'),
        refresh_token=stored.get('refresh_token'),
        token_uri='https://oauth2.googleapis.com/token',
        client_id=os.getenv('GOOGLE_CLIENT_ID'),
        client_secret=os.getenv('GOOGLE_CLIENT_SECRET'),
    )

    # Refresh proactively so background sync never depends on a one-hour token.
    if credentials.refresh_token:
        credentials.refresh(Request())
        supabase.table('google_credentials').update({
            'access_token': credentials.token,
            'updated_at': datetime.now(timezone.utc).isoformat(),
        }).eq('user_id', volunteer['id']).execute()

    return build('calendar', 'v3', credentials=credentials)


def sync_volunteer_calendar(supabase, volunteer):
    service = calendar_service(supabase, volunteer)
    if not service:
        return 0

    now = datetime.now(timezone.utc)
    time_max = now + timedelta(days=30)
    events = service.events().list(
        calendarId='primary',
        timeMin=now.isoformat(),
        timeMax=time_max.isoformat(),
        q='CYF',
        singleEvents=True,
        orderBy='startTime'
    ).execute().get('items', [])

    # q searches several Google Calendar fields. Only the event title defines a slot.
    cyf_events = []
    for event in events:
        title = event.get('summary', '')
        start = event.get('start', {}).get('dateTime')
        end = event.get('end', {}).get('dateTime')
        if 'CYF' not in title.upper() or not start or not end:
            continue
        if event.get('status') == 'cancelled':
            continue
        cyf_events.append((event, start, end))

    existing_slots = supabase.table('slots')\
        .select('id, google_event_id, status, cancelled_by')\
        .eq('volunteer_id', volunteer['id'])\
        .gte('start_time', now.isoformat())\
        .lte('start_time', time_max.isoformat())\
        .execute().data
    existing_by_event = {slot['google_event_id']: slot for slot in existing_slots}
    active_event_ids = set()

    for event, start, end in cyf_events:
        event_id = event['id']
        active_event_ids.add(event_id)
        existing = existing_by_event.get(event_id)

        if existing:
            update = {'start_time': start, 'end_time': end}
            # A restored Google event becomes available again, but a reservation is preserved.
            if existing['status'] == 'cancelled' and not existing.get('cancelled_by'):
                update['status'] = 'available'
            supabase.table('slots').update(update).eq('id', existing['id']).execute()
        else:
            supabase.table('slots').insert({
                'volunteer_id': volunteer['id'],
                'google_event_id': event_id,
                'start_time': start,
                'end_time': end,
                'status': 'available'
            }).execute()

    # Keep booking history, but stop offering slots removed from Google or renamed.
    for slot in existing_slots:
        if slot['status'] == 'available' and slot['google_event_id'] not in active_event_ids:
            supabase.table('slots').update({'status': 'cancelled'}).eq('id', slot['id']).execute()

    return len(cyf_events)


def confirm_google_booking(supabase, slot, volunteer, trainee, agenda=None):
    """Add the trainee and a Meet conference to the volunteer's CYF event."""
    service = calendar_service(supabase, volunteer)
    if not service:
        raise RuntimeError('calendar_not_connected')
    event = service.events().get(
        calendarId='primary',
        eventId=slot['google_event_id']
    ).execute()

    attendees = event.get('attendees', [])
    if not any(item.get('email') == trainee['email'] for item in attendees):
        attendees.append({
            'email': trainee['email'],
            'displayName': trainee.get('name')
        })

    description = event.get('description', '')
    agenda_text = f"CYF session agenda: {agenda}" if agenda else "CYF session"
    if agenda_text not in description:
        description = f"{description}\n\n{agenda_text}".strip()

    patch = {
        'attendees': attendees,
        'description': description,
    }
    if not event.get('conferenceData'):
        patch['conferenceData'] = {
            'createRequest': {
                'requestId': str(uuid4()),
                'conferenceSolutionKey': {'type': 'hangoutsMeet'}
            }
        }

    updated = service.events().patch(
        calendarId='primary',
        eventId=slot['google_event_id'],
        body=patch,
        conferenceDataVersion=1,
        sendUpdates='all'
    ).execute()

    if updated.get('hangoutLink'):
        return updated['hangoutLink']
    for entry in updated.get('conferenceData', {}).get('entryPoints', []):
        if entry.get('entryPointType') == 'video':
            return entry.get('uri')
    return None


def cancel_google_booking(supabase, slot, volunteer, trainee, reason=None):
    """Remove the trainee from a confirmed event and send a cancellation update."""
    service = calendar_service(supabase, volunteer)
    if not service:
        raise RuntimeError('calendar_not_connected')
    event = service.events().get(
        calendarId='primary',
        eventId=slot['google_event_id']
    ).execute()

    attendees = [
        attendee for attendee in event.get('attendees', [])
        if attendee.get('email') != trainee['email']
    ]
    note = "CYF session cancelled by an administrator."
    if reason:
        note += f" Reason: {reason}"
    description = event.get('description', '')
    if note not in description:
        description = f"{description}\n\n{note}".strip()

    service.events().patch(
        calendarId='primary',
        eventId=slot['google_event_id'],
        body={'attendees': attendees, 'description': description},
        sendUpdates='all'
    ).execute()
