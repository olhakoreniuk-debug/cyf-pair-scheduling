import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabaseClient'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function startOfWeek(date) {
  const result = new Date(date)
  const day = result.getDay() || 7
  result.setDate(result.getDate() - day + 1)
  result.setHours(0, 0, 0, 0)
  return result
}

function dateKey(value) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function calendarDays(viewDate, view) {
  const first = view === 'week'
    ? startOfWeek(viewDate)
    : startOfWeek(new Date(viewDate.getFullYear(), viewDate.getMonth(), 1))
  const count = view === 'week' ? 7 : 42
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(first)
    day.setDate(first.getDate() + index)
    return day
  })
}

function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [slots, setSlots] = useState([])
  const [bookings, setBookings] = useState([])
  const [adminUsers, setAdminUsers] = useState([])
  const [adminSlots, setAdminSlots] = useState([])
  const [adminTab, setAdminTab] = useState('users')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [agenda, setAgenda] = useState('')
  const [view, setView] = useState('month')
  const [viewDate, setViewDate] = useState(new Date())
  const [selectedSlot, setSelectedSlot] = useState(null)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      setSession(currentSession)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, currentSession) => {
        setSession(currentSession)

        if (currentSession?.provider_token) {
          await fetch(`${API_URL}/calendar/credentials`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${currentSession.access_token}`,
            },
            body: JSON.stringify({
              access_token: currentSession.provider_token,
              refresh_token: currentSession.provider_refresh_token || null,
            }),
          })
        }
      },
    )

    return () => subscription.unsubscribe()
  }, [])

  const api = async (path, options = {}) => {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        ...options.headers,
      },
    })
    const data = response.status === 204 ? null : await response.json()
    if (!response.ok) throw new Error(data?.detail || 'Something went wrong.')
    return data
  }

  const loadDashboard = async () => {
    if (!session) return
    setLoading(true)
    setError('')
    try {
      const currentProfile = await api('/me')
      setProfile(currentProfile)
      const bookingData = await api('/bookings')
      setBookings(bookingData)
      if (currentProfile.role === 'admin') {
        const [userData, slotData] = await Promise.all([
          api('/admin/users'),
          api('/admin/slots'),
        ])
        setAdminUsers(userData)
        setAdminSlots(slotData)
      } else if (currentProfile.role !== 'volunteer') {
        const slotResponse = await fetch(`${API_URL}/slots`)
        if (!slotResponse.ok) throw new Error('Could not load the calendar.')
        const slotData = await slotResponse.json()
        setSlots(slotData.sort((a, b) => new Date(a.start_time) - new Date(b.start_time)))
      }
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!session) return

    const load = async () => {
      setLoading(true)
      setError('')
      try {
        await loadDashboard()
      } catch (loadError) {
        setError(loadError.message)
      } finally {
        setLoading(false)
      }
    }

    load()
    // loadDashboard uses the current session after authentication changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  const slotsByDate = useMemo(() => slots.reduce((grouped, slot) => {
    const key = dateKey(slot.start_time)
    grouped[key] = [...(grouped[key] || []), slot]
    return grouped
  }, {}), [slots])

  const days = useMemo(() => calendarDays(viewDate, view), [viewDate, view])

  const changePeriod = (direction) => {
    const next = new Date(viewDate)
    if (view === 'month') next.setMonth(next.getMonth() + direction)
    else next.setDate(next.getDate() + (7 * direction))
    setViewDate(next)
  }

  const login = async (role) => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        ...(role === 'volunteer' && {
          scopes: 'https://www.googleapis.com/auth/calendar.events',
          queryParams: { access_type: 'offline', prompt: 'consent' },
        }),
        redirectTo: window.location.origin,
      },
    })
  }

  const requestSession = async () => {
    setMessage('')
    try {
      await api(`/slots/${selectedSlot.id}/request`, {
        method: 'POST',
        body: JSON.stringify({ agenda }),
      })
      setMessage('Request sent. The volunteer will review your agenda.')
      setSelectedSlot(null)
      setAgenda('')
      await loadDashboard()
    } catch (requestError) {
      setMessage(requestError.message)
    }
  }

  const decide = async (bookingId, decision) => {
    setMessage('')
    try {
      await api(`/bookings/${bookingId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      })
      setMessage(decision === 'confirmed'
        ? 'Session confirmed. Google has sent the invitation.'
        : 'Request declined. The slot is available again.')
      await loadDashboard()
    } catch (decisionError) {
      setMessage(decisionError.message)
    }
  }

  const changeAccountStatus = async (user, accountStatus) => {
    const action = accountStatus === 'active' ? 'restore' : accountStatus
    if (!window.confirm(`Are you sure you want to ${action} ${user.name}?`)) return
    const reason = accountStatus === 'active' ? '' : (window.prompt('Reason (optional):') || '')
    setMessage('')
    try {
      await api(`/admin/users/${user.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ account_status: accountStatus, reason }),
      })
      setMessage(`${user.name} is now ${accountStatus}.`)
      await loadDashboard()
    } catch (adminError) {
      setMessage(adminError.message)
    }
  }

  const cancelSlotAsAdmin = async (slot) => {
    if (!window.confirm('Cancel this session in the application?')) return
    const reason = window.prompt('Cancellation reason (optional):') || ''
    setMessage('')
    try {
      await api(`/admin/slots/${slot.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
      setMessage('Session cancelled.')
      await loadDashboard()
    } catch (adminError) {
      setMessage(adminError.message)
    }
  }

  if (!session) {
    return (
      <main className="login-page">
        <section className="login-card">
          <span className="eyebrow">CodeYourFuture</span>
          <h1>Find a pair.<br />Make progress.</h1>
          <p>Book a focused one-hour session with a volunteer when it suits you both.</p>
          <div className="login-actions">
            <button className="primary-button" onClick={() => login('trainee')}>Continue as a trainee</button>
            <button className="secondary-button" onClick={() => login('volunteer')}>Continue as a volunteer</button>
          </div>
        </section>
      </main>
    )
  }

  const title = view === 'month'
    ? viewDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : `${days[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  if (profile?.role === 'admin') {
    return (
      <main className="app-shell">
        <header className="topbar">
          <a className="brand" href="/">CYF <span>Pair Scheduling</span></a>
          <nav className="account-nav" aria-label="Account">
            <span className="admin-badge">Admin</span>
            <span className="user-email">{profile.name}</span>
            <button className="sign-out" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </nav>
        </header>
        <section className="page-intro admin-intro">
          <div>
            <span className="eyebrow">Administration</span>
            <h1>Keep sessions safe</h1>
            <p>Manage access, review bookings and cancel sessions when necessary.</p>
          </div>
        </section>
        {message && <div className="toast" role="status">{message}</div>}
        {error && <div className="dashboard-error" role="alert">{error}</div>}
        <section className="admin-section">
          <div className="admin-tabs" role="tablist">
            {['users', 'sessions', 'bookings'].map((tab) => (
              <button key={tab} className={adminTab === tab ? 'active' : ''} onClick={() => setAdminTab(tab)}>{tab}</button>
            ))}
          </div>

          {loading ? <p className="empty-state">Loading administration data…</p> : adminTab === 'users' ? (
            <div className="admin-table">
              <div className="admin-table-head"><span>User</span><span>Role</span><span>Status</span><span>Actions</span></div>
              {adminUsers.map((user) => (
                <article key={user.id}>
                  <div><strong>{user.name}</strong><small>{user.email}</small></div>
                  <span className="role-label">{user.role}</span>
                  <span className={`booking-status ${user.account_status}`}>{user.account_status}</span>
                  <div className="admin-actions">
                    {user.id === profile.id ? <span className="current-admin">Current account</span> : user.account_status === 'active' ? <>
                      <button onClick={() => changeAccountStatus(user, 'deactivated')}>Deactivate</button>
                      <button className="danger-action" onClick={() => changeAccountStatus(user, 'banned')}>Ban</button>
                    </> : <button onClick={() => changeAccountStatus(user, 'active')}>Restore</button>}
                  </div>
                </article>
              ))}
            </div>
          ) : adminTab === 'sessions' ? (
            <div className="admin-table sessions-table">
              <div className="admin-table-head"><span>Date</span><span>Volunteer</span><span>Status</span><span>Actions</span></div>
              {adminSlots.map((slot) => (
                <article key={slot.id}>
                  <div><strong>{new Date(slot.start_time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</strong><small>{new Date(slot.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div>
                  <span>{slot.users?.name}</span>
                  <span className={`booking-status ${slot.status}`}>{slot.status}</span>
                  <div className="admin-actions">{slot.status !== 'cancelled' && <button className="danger-action" onClick={() => cancelSlotAsAdmin(slot)}>Cancel</button>}</div>
                </article>
              ))}
            </div>
          ) : (
            <div className="admin-table bookings-table">
              <div className="admin-table-head"><span>Session</span><span>People</span><span>Agenda</span><span>Status</span></div>
              {bookings.map((booking) => (
                <article key={booking.id}>
                  <div><strong>{new Date(booking.slot.start_time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</strong><small>{new Date(booking.slot.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div>
                  <div><strong>{booking.trainee.name}</strong><small>with {booking.volunteer.name}</small></div>
                  <span>{booking.agenda || '—'}</span>
                  <span className={`booking-status ${booking.status}`}>{booking.status}</span>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    )
  }

  if (profile?.role === 'volunteer') {
    const pending = bookings.filter((booking) => booking.status === 'pending')
    return (
      <main className="app-shell">
        <header className="topbar">
          <a className="brand" href="/">CYF <span>Pair Scheduling</span></a>
          <nav className="account-nav" aria-label="Account">
            <span className="user-email">{profile.name}</span>
            <button className="sign-out" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </nav>
        </header>
        <section className="page-intro volunteer-intro">
          <div>
            <span className="eyebrow">Volunteer dashboard</span>
            <h1>Session requests</h1>
            <p>Review each trainee’s agenda before confirming the calendar invitation.</p>
          </div>
          <button className="secondary-button sync-button" onClick={async () => {
            setMessage('')
            try {
              const result = await api('/sync', { method: 'POST' })
              setMessage(`${result.synced_slots} CYF slots synced.`)
            } catch {
              setMessage('Calendar sync failed.')
            }
          }}>Sync Google Calendar</button>
        </section>
        {message && <div className="toast" role="status">{message}</div>}
        {error && <div className="dashboard-error" role="alert">{error}</div>}
        <section className="requests-section">
          <div className="section-title"><h2>Waiting for your decision</h2><span>{pending.length}</span></div>
          {loading ? <p className="empty-state">Loading requests…</p> : pending.length === 0 ? (
            <p className="empty-state">No pending requests. New requests will appear here.</p>
          ) : (
            <div className="request-grid">{pending.map((booking) => (
              <article className="request-card" key={booking.id}>
                <div className="request-date">
                  <strong>{new Date(booking.slot.start_time).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
                  <span>{new Date(booking.slot.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {new Date(booking.slot.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="trainee-row"><span className="avatar">{booking.trainee.name?.charAt(0) || 'T'}</span><div><small>Trainee</small><strong>{booking.trainee.name}</strong></div></div>
                <div className="agenda-box"><small>Agenda</small><p>{booking.agenda || 'No agenda provided.'}</p></div>
                <div className="decision-actions">
                  <button className="decline-button" onClick={() => decide(booking.id, 'declined')}>Decline</button>
                  <button className="primary-button" onClick={() => decide(booking.id, 'confirmed')}>Confirm & send invite</button>
                </div>
              </article>
            ))}</div>
          )}
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">CYF <span>Pair Scheduling</span></a>
        <nav className="account-nav" aria-label="Account">
          <button className="nav-link">My sessions</button>
          <span className="user-email">{session.user.email}</span>
          <button className="sign-out" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </nav>
      </header>

      <section className="page-intro">
        <div>
          <span className="eyebrow">Available sessions</span>
          <h1>Find a volunteer</h1>
          <p>Choose a one-hour session that works for you. Select a time to see the details.</p>
        </div>
        <div className="timezone-card">
          <span>Times shown in</span>
          <strong>{timezone}</strong>
        </div>
      </section>

      <section className="calendar-section" aria-label="Available sessions calendar">
        <div className="calendar-toolbar">
          <button className="today-button" onClick={() => setViewDate(new Date())}>Today</button>
          <div className="month-nav">
            <button className="period-button" aria-label="Previous period" onClick={() => changePeriod(-1)}>←</button>
            <h2>{title}</h2>
            <button className="period-button" aria-label="Next period" onClick={() => changePeriod(1)}>→</button>
          </div>
          <div className="view-switch" aria-label="Calendar view">
            <button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>Month</button>
            <button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>Week</button>
          </div>
        </div>

        {error && <div className="error-message" role="alert">{error}</div>}
        {loading ? <div className="calendar-state">Loading available sessions…</div> : (
          <div className={`calendar-grid ${view}`}>
            {WEEKDAYS.map((weekday) => <div className="weekday" key={weekday}>{weekday}</div>)}
            {days.map((day) => {
              const daySlots = slotsByDate[dateKey(day)] || []
              const outsideMonth = view === 'month' && day.getMonth() !== viewDate.getMonth()
              const isToday = dateKey(day) === dateKey(new Date())
              return (
                <div className={`day-cell ${outsideMonth ? 'outside' : ''}`} key={dateKey(day)}>
                  <time className={isToday ? 'today' : ''} dateTime={dateKey(day)}>{day.getDate()}</time>
                  <div className="day-slots">
                    {daySlots.slice(0, 3).map((slot) => (
                      <button className="slot-chip" key={slot.id} onClick={() => setSelectedSlot(slot)}>
                        <strong>{new Date(slot.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>
                        <span>{slot.users?.name || 'CYF volunteer'}</span>
                      </button>
                    ))}
                    {daySlots.length > 3 && <button className="more-slots">+{daySlots.length - 3} more</button>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {message && <div className="toast" role="status">{message}</div>}

      <section className="my-sessions" id="my-sessions">
        <div className="section-title"><h2>My sessions</h2><span>{bookings.length}</span></div>
        {bookings.length === 0 ? <p className="empty-state">You have not requested a session yet.</p> : (
          <div className="session-list">{bookings.map((booking) => (
            <article key={booking.id}>
              <div><strong>{new Date(booking.slot.start_time).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</strong><span>{new Date(booking.slot.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} with {booking.volunteer.name}</span></div>
              <span className={`booking-status ${booking.status}`}>{booking.status}</span>
              {booking.google_meet_link && <a href={booking.google_meet_link} target="_blank" rel="noreferrer">Join Meet</a>}
            </article>
          ))}</div>
        )}
      </section>

      {selectedSlot && (
        <div className="panel-backdrop" onMouseDown={() => setSelectedSlot(null)}>
          <aside className="slot-panel" aria-label="Session details" onMouseDown={(event) => event.stopPropagation()}>
            <button className="close-panel" aria-label="Close details" onClick={() => setSelectedSlot(null)}>×</button>
            <span className="eyebrow">Session details</span>
            <h2>{new Date(selectedSlot.start_time).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
            <p className="panel-time">
              {new Date(selectedSlot.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {' – '}
              {new Date(selectedSlot.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
            <div className="volunteer-detail">
              <span className="avatar">{selectedSlot.users?.name?.charAt(0) || 'V'}</span>
              <div><small>Volunteer</small><strong>{selectedSlot.users?.name || 'CYF volunteer'}</strong></div>
            </div>
            <label htmlFor="agenda">What would you like to work on?</label>
            <textarea id="agenda" placeholder="Optional agenda" rows="4" maxLength="1000" value={agenda} onChange={(event) => setAgenda(event.target.value)} />
            <button className="primary-button book-button" onClick={requestSession}>Send request</button>
            <p className="panel-note">The volunteer will read your agenda before confirming the Google Meet invitation.</p>
          </aside>
        </div>
      )}
    </main>
  )
}

export default App
