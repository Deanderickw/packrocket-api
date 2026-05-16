// @ts-nocheck
/* ========= PackRocket API — Express + Supabase + Stripe ========= */
const express = require("express")
const cors = require("cors")
const Stripe = require("stripe")
const { createClient } = require("@supabase/supabase-js")
const multer = require("multer")
const { Resend } = require("resend")
require("dotenv").config()

const PORT = process.env.PORT || 5050
const app = express()

/* ------------------------- init clients ------------------------- */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
})

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

let _supabaseAuth = null
function getSupabaseAuth() {
  if (!_supabaseAuth) {
    const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
    _supabaseAuth = createClient(process.env.SUPABASE_URL, key)
  }
  return _supabaseAuth
}

const resend = new Resend(process.env.RESEND_API_KEY)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

const LOGO_BUCKET = process.env.SUPABASE_LOGO_BUCKET || "logos"

/* ------------------------- helpers ------------------------- */

function normalizeEmail(email) {
  if (!email) return ""
  return String(email).trim().toLowerCase()
}

function computeProfileCompletion(profile) {
  if (!profile) return 0
  const fields = [
    profile.full_name,
    profile.business_name,
    profile.phone_e164,
    profile.city,
    profile.state,
    profile.zip,
    profile.logo_url,
  ]
  const filled = fields.filter((v) => v && String(v).trim() !== "").length
  const total = fields.length || 1
  return Math.round((filled / total) * 100)
}

function formatDateLabel(isoOrMillis) {
  if (!isoOrMillis) return "N/A"
  let date
  if (typeof isoOrMillis === "number") {
    date = new Date(isoOrMillis * 1000)
  } else {
    date = new Date(isoOrMillis)
  }
  if (isNaN(date.getTime())) return "N/A"
  const options = { month: "short", day: "numeric", year: "numeric" }
  return date.toLocaleDateString("en-US", options)
}

function mapProfileToMover(profileRow) {
  if (!profileRow) return {}
  return {
    id: profileRow.id,
    name: profileRow.full_name || profileRow.business_name || "Mover",
    full_name: profileRow.full_name || "",
    business_name: profileRow.business_name || "",
    email: profileRow.email || "",
    phone: profileRow.phone_e164 || "",
    city: profileRow.city || "",
    state: profileRow.state || "",
    zip: profileRow.zip || "",
    logo: profileRow.logo_url || "",
    verified: true,
    rating: 4.9,
    jobsCompleted: 0,
    startingPrice:
      profileRow.starting_price !== null &&
      profileRow.starting_price !== undefined &&
      profileRow.starting_price !== ""
        ? Number(profileRow.starting_price)
        : undefined,
    features: [],
    plan: profileRow.plan || "Free",
    status: profileRow.status || "pending",
    profileCompletion: computeProfileCompletion(profileRow),
  }
}

async function geocodeMoverAddress({ city, state, zip }) {
  const parts = [city, state, zip].filter(Boolean).join(" ").trim()
  if (!parts) throw new Error("No address to geocode")
  console.log("Geocoding parts:", parts)

  // Try Census geocoder first (no rate limits, US only)
  try {
   const censusUrl = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(parts + ", US")}&benchmark=Public_AR_Current&format=json`
    const res = await fetch(censusUrl, { 
      headers: { "User-Agent": "PackRocket/1.0" },
      signal: AbortSignal.timeout(8000)
    })
    const data = await res.json()
    const match = data?.result?.addressMatches?.[0]
    if (match) {
      return {
        lat: parseFloat(match.coordinates.y),
        lng: parseFloat(match.coordinates.x),
      }
    }
  } catch (e) {
    console.warn("Census geocoder failed:", e.message)
  }

  // Try Photon (no API key, no rate limits)
  try {
   const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(parts)}&limit=1&countrycode=us`
    const res = await fetch(photonUrl, {
      headers: { "User-Agent": "PackRocket/1.0 (packrocket.co)" },
      signal: AbortSignal.timeout(8000)
    })
    const data = await res.json()
    const feature = data?.features?.[0]
    if (feature) {
      return {
        lat: feature.geometry.coordinates[1],
        lng: feature.geometry.coordinates[0],
      }
    }
  } catch (e) {
    console.warn("Photon geocoder failed:", e.message)
  }

  throw new Error("All geocoders failed")
}

/* 
  Syncs a signed-up/updated profile into the movers table in Supabase.
  Previously this wrote to Airtable — now it writes to Supabase movers.
*/
async function upsertSupabaseMoverFromProfile(profileRow) {
  try {
    const email = normalizeEmail(profileRow.email)
    if (!email) return

    const name    = profileRow.business_name || profileRow.full_name || "Mover"
    const city    = profileRow.city  || ""
    const state   = profileRow.state || ""
    const zip     = profileRow.zip   || ""
    const plan    = profileRow.plan  || "Free"
    const logoUrl = profileRow.logo_url || ""
    const startingPrice = profileRow.starting_price || null
    const radius  = profileRow.service_radius_miles ?? 50

    let lat = profileRow.lat ?? null
    let lng = profileRow.lng ?? null

    if ((city || state || zip) && (!lat || !lng)) {
      try {
        const coords = await geocodeMoverAddress({ city, state, zip })
        lat = coords.lat
        lng = coords.lng
        console.log(`📍 Geocoded ${email}: ${lat}, ${lng}`)

        await supabase
          .from("profiles")
          .update({ lat, lng, geo_updated_at: new Date().toISOString() })
          .eq("email", email)
      } catch (geoErr) {
        console.warn("Geocode failed for", email, "—", geoErr.message)
      }
    }

    const moverData = {
      email,
      name,
      phone: profileRow.phone_e164 || "",
      city,
      state,
      zip,
      plan,
      service_radius_miles: radius,
      logo_url: logoUrl || null,
      starting_price: startingPrice,
    }

    if (lat !== null) moverData.lat = lat
    if (lng !== null) moverData.lng = lng

    // Check if mover already exists in movers table
    const { data: existing } = await supabase
      .from("movers")
      .select("id")
      .ilike("email", email)
      .maybeSingle()

    if (existing?.id) {
      await supabase.from("movers").update(moverData).eq("id", existing.id)
      console.log("✅ Supabase movers upsert (update) for:", email)
    } else {
      await supabase.from("movers").insert([moverData])
      console.log("✅ Supabase movers upsert (insert) for:", email)
    }
  } catch (err) {
    console.error("Supabase movers sync failed:", err)
  }
}

/* ------------------------- Airtable shape mapper ------------------------- */

function mapMoverToAirtableShape(mover) {
  return {
    id: mover.id,
    fields: {
      Name: mover.name,
      Email: mover.email,
      Phone: mover.phone,
      City: mover.city,
      State: mover.state,
      ZIP: mover.zip,
      Lat: mover.lat,
      Lng: mover.lng,
      Verified: mover.verified === true || mover.verified === "true" || mover.verified === "checked",
      ["Starting price"]: mover.starting_price ? Number(mover.starting_price) : undefined,
      Rating: mover.rating ? Number(mover.rating) : undefined,
      Features: mover.features
        ? String(mover.features).split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      Logo: mover.logo_url ? [{ url: mover.logo_url }] : [],
      ["Hero Photo"]: mover.hero_photo_url ? [{ url: mover.hero_photo_url }] : [],
      Photo: mover.photo_url ? [{ url: mover.photo_url }] : [],
      Description: mover.description || "",
      ["Service Areas"]: mover.service_areas || "",
      Services: mover.services
        ? String(mover.services).split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      Plan: mover.plan || "Free",
      Badge: mover.badge || "",
      ["Response Time"]: mover.response_time || "",
      ["Price Range"]: mover.price_range_max ? `$0–$${mover.price_range_max}` : "",
      service_radius_miles: mover.service_radius_miles,
      _distanceMiles: mover._distanceMiles ?? null,
    },
  }
}

/* ------------------------- Haversine ------------------------- */

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/* ------------------------- Stripe price IDs ------------------------- */

const PRICE_IDS = {
  Pro: process.env.STRIPE_PRICE_PRO,
  Enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
}

/* ------------------------- CORS ------------------------- */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
)

/* ---------- STRIPE WEBHOOK: must be BEFORE express.json ---------- */

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"]
    let event

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message)
      return res.status(400).send("Webhook Error")
    }

    res.sendStatus(200)

    ;(async () => {
      try {
        const type = event.type

        const updateProfileByCustomerId = async (customerId, updates) => {
          if (!customerId) return
          const { data: user, error: findErr } = await supabase
            .from("profiles")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle()
          if (findErr) { console.error("Supabase lookup error:", findErr); return }
          if (!user?.id) return
          const { error: updErr } = await supabase
            .from("profiles")
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq("id", user.id)
          if (updErr) console.error("Supabase update error:", updErr)
        }

        if (type === "checkout.session.completed") {
          const session = event.data.object
          const customerId = session.customer
          const subscriptionId = session.subscription
          let currentPeriodEndISO = null
          if (subscriptionId) {
            const sub = await stripe.subscriptions.retrieve(subscriptionId)
            currentPeriodEndISO = new Date(sub.current_period_end * 1000).toISOString()
          }
          await updateProfileByCustomerId(customerId, {
            status: "active",
            stripe_subscription_id: subscriptionId || null,
            current_period_end: currentPeriodEndISO,
          })
          console.log("✅ checkout.session.completed → activated:", customerId)
        }

        if (type === "customer.subscription.updated") {
          const sub = event.data.object
          const statusMap = {
            active: "active",
            trialing: "active",
            past_due: "past_due",
            unpaid: "past_due",
            canceled: "canceled",
            incomplete: "pending",
            incomplete_expired: "canceled",
            paused: "paused",
          }
          await updateProfileByCustomerId(sub.customer, {
            stripe_subscription_id: sub.id,
            status: statusMap[sub.status] || "active",
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
        }

        if (type === "invoice.paid") {
          const invoice = event.data.object
          const customerId = invoice.customer
          const subscriptionId = invoice.subscription
          let currentPeriodEndISO = null
          if (subscriptionId) {
            const sub = await stripe.subscriptions.retrieve(subscriptionId)
            currentPeriodEndISO = new Date(sub.current_period_end * 1000).toISOString()
          }
          await updateProfileByCustomerId(customerId, {
            status: "active",
            stripe_subscription_id: subscriptionId || null,
            current_period_end: currentPeriodEndISO,
          })
        }

        if (type === "invoice.payment_failed") {
          const invoice = event.data.object
          await updateProfileByCustomerId(invoice.customer, { status: "past_due" })
        }

        if (type === "customer.subscription.deleted") {
          const sub = event.data.object
          await updateProfileByCustomerId(sub.customer, {
            status: "canceled",
            stripe_subscription_id: sub.id,
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
        }
      } catch (err) {
        console.error("⚠️ Webhook async handler error:", err)
      }
    })()
  }
)

/* --------------------- JSON middleware ------------------ */

app.use(express.json())

/* ------------------------ Health check ------------------------ */

app.get("/api/health", (_req, res) => res.json({ ok: true }))


/* ------------------------ Create Lead + Email Mover ------------------------ */

app.post("/api/leads", async (req, res) => {
  try {
    const {
      moverId,
      customerName,
      customerPhone,
      customerEmail,
      moveDate,
      pickupAddress,
      dropoffAddress,
      homeSize,
      notes,
    } = req.body || {}

    if (!moverId || !customerName || !customerPhone || !moveDate) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: moverId, customerName, customerPhone, moveDate",
      })
    }

    let moverEmail = ""
    let moverDisplayName = "Mover"
    let supabaseMoverId = null
    let moverPlan = "Free"

    // First try profiles table
    const { data: supabaseMover } = await supabase
      .from("profiles")
      .select("id, email, business_name, full_name, plan")
      .eq("id", moverId)
      .maybeSingle()

    if (supabaseMover?.email) {
      moverEmail = supabaseMover.email
      moverDisplayName = supabaseMover.business_name || supabaseMover.full_name || "Mover"
      supabaseMoverId = supabaseMover.id
      moverPlan = supabaseMover.plan || "Free"
    } else {
      // Fall back to movers table (manually added movers not yet signed up)
      const { data: moverRow } = await supabase
        .from("movers")
        .select("id, email, name, plan")
        .eq("id", moverId)
        .maybeSingle()

      if (moverRow?.email) {
        moverEmail = moverRow.email
        moverDisplayName = moverRow.name || "Mover"
        moverPlan = moverRow.plan || "Free"

        // Try to find a matching profile
        const { data: profileByEmail } = await supabase
          .from("profiles")
          .select("id, plan")
          .ilike("email", moverRow.email)
          .maybeSingle()

        if (profileByEmail) {
          supabaseMoverId = profileByEmail.id
          moverPlan = profileByEmail.plan || moverPlan
        }
      }
    }

    if (!moverEmail) {
      return res.status(404).json({ ok: false, error: "Mover not found or missing email" })
    }

    // Free plan: 2 leads per calendar month
    if (moverPlan === "Free" && supabaseMoverId) {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()

      const { count } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("mover_id", supabaseMoverId)
        .gte("created_at", monthStart)
        .lt("created_at", monthEnd)

      if (count >= 1) {
        return res.status(403).json({
          ok: false,
          code: "FREE_PLAN_LIMIT",
          error: "This mover isn't available right now. Try contacting another mover.",
        })
      }
    }

    let leadId = null
    if (supabaseMoverId) {
      const { data: leadRow, error: leadErr } = await supabase
        .from("leads")
        .insert([{
          mover_id: supabaseMoverId,
          customer_name: customerName,
          customer_phone: customerPhone,
          customer_email: customerEmail || null,
          move_date: moveDate,
          pickup_address: pickupAddress || null,
          dropoff_address: dropoffAddress || null,
          home_size: homeSize || null,
          notes: notes || null,
          sent_status: "pending",
        }])
        .select("id")
        .single()
      if (leadErr) console.error("Lead insert error:", leadErr?.message)
      else leadId = leadRow?.id
    }

    const subject = `New PackRocket Move Request — ${customerName} (${moveDate})`
    const text =
      `New PackRocket Move Request\n\n` +
      `Mover: ${moverDisplayName}\n` +
      `Customer: ${customerName}\n` +
      `Phone: ${customerPhone}\n` +
      (customerEmail ? `Email: ${customerEmail}\n` : "") +
      `Move Date: ${moveDate}\n` +
      (pickupAddress ? `Pickup: ${pickupAddress}\n` : "") +
      (dropoffAddress ? `Dropoff: ${dropoffAddress}\n` : "") +
      (homeSize ? `Home Size: ${homeSize}\n` : "") +
      (notes ? `Notes: ${notes}\n` : "") +
      (leadId ? `\nLead ID: ${leadId}\n` : "")

    const emailResult = await resend.emails.send({
      from: "PackRocket Leads <leads@packrocket.co>",
      to: [moverEmail],
      bcc: process.env.LEADS_BCC_EMAIL ? [process.env.LEADS_BCC_EMAIL] : undefined,
      subject,
      text,
    })

    if (leadId) {
      await supabase.from("leads").update({
        sent_status: "sent",
        sent_at: new Date().toISOString(),
        email_provider_id: emailResult?.data?.id || null,
      }).eq("id", leadId)
    }

    return res.json({ ok: true, leadId })
  } catch (err) {
    console.error("/api/leads error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* -------------------- Message a mover -------------------- */

app.post("/api/message", async (req, res) => {
  try {
    const {
      moverId,
      moverName,
      moverEmail: providedEmail,
      customerName,
      customerPhone,
      message,
      pickupCity,
      dropoffCity,
    } = req.body || {}

    if (!customerName || !customerPhone) {
      return res.status(400).json({ ok: false, error: "Missing required fields" })
    }

    let moverEmail = providedEmail || ""

    if (!moverEmail && moverId) {
      // Try movers table
      const { data: moverRow } = await supabase
        .from("movers")
        .select("email")
        .eq("id", moverId)
        .maybeSingle()
      moverEmail = moverRow?.email || ""
    }

    if (!moverEmail) {
      return res.json({ ok: true, note: "Message received but no email found for mover" })
    }

    // Free plan limit check
    let messageMoverPlan = "Free"
    let messageSupabaseMoverId = null
    const { data: moverProfile } = await supabase
      .from("profiles")
      .select("id, plan")
      .ilike("email", moverEmail)
      .maybeSingle()
    if (moverProfile) {
      messageMoverPlan = moverProfile.plan || "Free"
      messageSupabaseMoverId = moverProfile.id
    }

    if (messageMoverPlan === "Free" && messageSupabaseMoverId) {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()

      const { count } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("mover_id", messageSupabaseMoverId)
        .gte("created_at", monthStart)
        .lt("created_at", monthEnd)

      if (count >= 1) {
        return res.status(403).json({
          ok: false,
          code: "FREE_PLAN_LIMIT",
          error: "This mover isn't available right now. Try contacting another mover.",
        })
      }
    }

    await resend.emails.send({
      from: "PackRocket <leads@packrocket.co>",
      to: [moverEmail],
      bcc: process.env.LEADS_BCC_EMAIL ? [process.env.LEADS_BCC_EMAIL] : undefined,
      subject: `🚛 New message from ${customerName} via PackRocket`,
      text:
        `You have a new message from a customer on PackRocket!\n\n` +
        `────────────────────────\n` +
        `Mover: ${moverName || "N/A"}\n` +
        `Customer: ${customerName}\n` +
        `Phone: ${customerPhone}\n` +
        (pickupCity ? `Pickup: ${pickupCity}\n` : "") +
        (dropoffCity ? `Drop-off: ${dropoffCity}\n` : "") +
        (message ? `\nMessage:\n"${message}"\n` : "") +
        `────────────────────────\n\n` +
        `Reply directly to this customer by calling or texting ${customerPhone}.\n\n` +
        `– The PackRocket Team\nhttps://packrocket.co`,
    })

    try {
      if (messageSupabaseMoverId) {
        await supabase.from("leads").insert([{
          mover_id: messageSupabaseMoverId,
          customer_name: customerName,
          customer_phone: customerPhone,
          customer_email: null,
          move_date: null,
          pickup_address: pickupCity || null,
          dropoff_address: dropoffCity || null,
          home_size: null,
          notes: message || null,
          sent_status: "sent",
          sent_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }])
      }
    } catch (leadErr) {
      console.error("Lead save error (non-fatal):", leadErr?.message)
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error("/api/message error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* -------------------- Get messages for a mover -------------------- */

app.get("/api/messages", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email)
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" })

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle()

    if (!profile?.id) return res.json({ ok: true, messages: [] })

    const { data: leads, error } = await supabase
      .from("leads")
      .select("id, customer_name, customer_phone, customer_email, move_date, pickup_address, dropoff_address, home_size, notes, sent_at, created_at")
      .eq("mover_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) return res.json({ ok: true, messages: [] })

    return res.json({ ok: true, messages: leads || [] })
  } catch (err) {
    console.error("/api/messages error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* -------------------- Submit a review -------------------- */

app.post("/api/reviews", async (req, res) => {
  try {
    const { moverId, customerName, rating, comment } = req.body || {}
    if (!moverId || !customerName || !rating) {
      return res.status(400).json({ ok: false, error: "Missing required fields" })
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: "Rating must be 1-5" })
    }

    const { data, error } = await supabase
      .from("reviews")
      .insert([{
        mover_id: moverId,
        customer_name: customerName,
        rating: Number(rating),
        comment: comment || "",
        created_at: new Date().toISOString(),
      }])
      .select("id")
      .single()

    if (error) {
      return res.status(500).json({ ok: false, error: error.message || "Failed to save review" })
    }

    // Update average rating in movers table
    try {
      const { data: allReviews } = await supabase
        .from("reviews")
        .select("rating")
        .eq("mover_id", moverId)

      if (allReviews?.length) {
        const avg = allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length
        await supabase
          .from("movers")
          .update({ rating: parseFloat(avg.toFixed(1)) })
          .eq("id", moverId)
      }
    } catch (ratingErr) {
      console.error("Rating sync failed:", ratingErr?.message)
    }

    return res.json({ ok: true, reviewId: data?.id })
  } catch (err) {
    console.error("/api/reviews error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* -------------------- Get reviews for a mover -------------------- */

app.get("/api/reviews/:moverId", async (req, res) => {
  try {
    const { moverId } = req.params
    if (!moverId) return res.status(400).json({ ok: false, error: "Missing moverId" })

    const { data, error } = await supabase
      .from("reviews")
      .select("id, customer_name, rating, comment, created_at")
      .eq("mover_id", moverId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) return res.json({ ok: true, reviews: [] })

    const avg = data?.length ? data.reduce((s, r) => s + r.rating, 0) / data.length : 0

    return res.json({ ok: true, reviews: data || [], averageRating: parseFloat(avg.toFixed(1)), totalReviews: data?.length || 0 })
  } catch (err) {
    console.error("/api/reviews/:moverId error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* -------------------- Forgot password -------------------- */

app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" })

    const normalizedEmail = normalizeEmail(email)
    const baseUrl = process.env.PUBLIC_URL || "https://packrocket.co"

    const { data, error } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email: normalizedEmail,
      options: { redirectTo: `${baseUrl}/reset-password` },
    })

    if (error) return res.json({ ok: true })

    const resetLink = data?.properties?.action_link || data?.action_link || ""

    if (resetLink) {
      await resend.emails.send({
        from: "PackRocket <noreply@packrocket.co>",
        to: [normalizedEmail],
        subject: "Reset your PackRocket password",
        text: `Hi there,\n\nWe received a request to reset your PackRocket password.\n\nClick the link below to set a new password:\n${resetLink}\n\nThis link expires in 1 hour.\n\n– The PackRocket Team`,
        html: `<p>Hi there,</p><p>We received a request to reset your PackRocket password.</p><p><a href="${resetLink}" style="display:inline-block;padding:12px 24px;background:#0084FF;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">Reset My Password</a></p><p>This link expires in 1 hour.</p><p>– The PackRocket Team</p>`,
      })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error("/api/forgot-password error:", err)
    return res.json({ ok: true })
  }
})

/* -------------------- Update password -------------------- */

app.post("/api/update-password", async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body || {}

    if (!email || !newPassword) {
      return res.status(400).json({ ok: false, error: "Missing required fields" })
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: "New password must be at least 8 characters" })
    }

    const normalizedEmail = normalizeEmail(email)

    if (currentPassword) {
      const { error: signInErr } = await getSupabaseAuth().auth.signInWithPassword({
        email: normalizedEmail,
        password: currentPassword,
      })
      if (signInErr) {
        return res.status(400).json({ ok: false, error: "Current password is incorrect" })
      }
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle()

    if (!profile?.id) {
      return res.status(404).json({ ok: false, error: "User not found" })
    }

    const { error: updateErr } = await supabase.auth.admin.updateUserById(profile.id, { password: newPassword })

    if (updateErr) {
      return res.status(500).json({ ok: false, error: "Failed to update password" })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error("/api/update-password error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* -------------------- Reset password via token -------------------- */

app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {}

    if (!token || !newPassword) {
      return res.status(400).json({ ok: false, error: "Missing token or new password" })
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: "Password must be at least 8 characters" })
    }

    const { data: sessionData, error: sessionErr } = await supabase.auth.exchangeCodeForSession(token)

    if (sessionErr || !sessionData?.user) {
      return res.status(400).json({ ok: false, error: "Invalid or expired reset link. Please request a new one." })
    }

    const { error: updateErr } = await supabase.auth.admin.updateUserById(sessionData.user.id, { password: newPassword })

    if (updateErr) {
      return res.status(500).json({ ok: false, error: "Failed to set new password" })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error("/api/reset-password error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ---------------------------- Upload logo ---------------------------- */

app.post("/api/upload-logo", upload.single("file"), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email)
    const file = req.file

    if (!email) return res.status(400).json({ ok: false, error: "Missing email" })
    if (!file) return res.status(400).json({ ok: false, error: "Missing file" })

    const originalName = file.originalname || "logo.png"
    const ext = originalName.includes(".") ? originalName.split(".").pop() : "png"
    const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, "_")
    const filePath = `${safeEmail}/${Date.now()}-logo.${ext}`

    const { error: uploadError } = await supabase.storage
      .from(LOGO_BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype || "image/png",
        upsert: false,
      })

    if (uploadError) {
      return res.status(500).json({ ok: false, error: "Failed to upload logo" })
    }

    const { data: { publicUrl } } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(filePath)

    if (!publicUrl) {
      return res.status(500).json({ ok: false, error: "Could not get public logo URL" })
    }

    await supabase.from("profiles").update({ logo_url: publicUrl, updated_at: new Date().toISOString() }).eq("email", email)
    await supabase.from("movers").update({ logo_url: publicUrl }).ilike("email", email)

    console.log("✅ Logo saved:", publicUrl)
    return res.json({ ok: true, url: publicUrl })
  } catch (err) {
    console.error("/api/upload-logo error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Upload hero photo ── */

app.post("/api/upload-hero", upload.single("file"), async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email)
    const file = req.file

    if (!email) return res.status(400).json({ ok: false, error: "Missing email" })
    if (!file) return res.status(400).json({ ok: false, error: "Missing file" })

    const ext = (file.originalname || "hero.jpg").split(".").pop()
    const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, "_")
    const filePath = `${safeEmail}/${Date.now()}-hero.${ext}`

    const { error: uploadError } = await supabase.storage
      .from(LOGO_BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype || "image/jpeg",
        upsert: false,
      })

    if (uploadError) {
      return res.status(500).json({ ok: false, error: "Failed to upload hero photo" })
    }

    const { data: { publicUrl } } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(filePath)

    if (!publicUrl) {
      return res.status(500).json({ ok: false, error: "Could not get public URL" })
    }

    await supabase.from("movers").update({ hero_photo_url: publicUrl }).ilike("email", email)

    return res.json({ ok: true, url: publicUrl })
  } catch (err) {
    console.error("/api/upload-hero error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Nearby movers by radius ── */

app.get("/api/movers/nearby", async (req, res) => {
  try {
    const radiusMiles = Math.min(500, Math.max(1, parseFloat(req.query.radius) || 50))
    const zipParam = String(req.query.zip || "").trim()
    const latParam = parseFloat(req.query.lat)
    const lngParam = parseFloat(req.query.lng)

    let centerLat = null
    let centerLng = null

    if (isFinite(latParam) && isFinite(lngParam)) {
      centerLat = latParam
      centerLng = lngParam
    } else if (zipParam) {
      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zipParam)}&country=us&format=json&limit=1`,
          { headers: { "User-Agent": "PackRocket/1.0", "Accept-Language": "en" } }
        )
        const geoData = await geoRes.json()
        if (geoData?.[0]) {
          centerLat = parseFloat(geoData[0].lat)
          centerLng = parseFloat(geoData[0].lon)
        }
      } catch (geoErr) {
        console.error("Geocode error:", geoErr?.message)
      }
    }

    if (!isFinite(centerLat) || !isFinite(centerLng)) {
      return res.status(400).json({ ok: false, error: "Could not resolve location." })
    }

    const { data: allMovers, error } = await supabase
      .from("movers")
      .select("*")
      .limit(500)

    if (error) return res.status(500).json({ ok: false, error: "Failed to fetch movers" })

    const nearby = []
    for (const mover of allMovers) {
      const lat = mover.lat
      const lng = mover.lng
      if (!isFinite(lat) || !isFinite(lng)) continue
      const dist = haversineMiles(centerLat, centerLng, lat, lng)
      if (dist <= radiusMiles) {
        nearby.push({ mover, distanceMiles: Math.round(dist * 10) / 10 })
      }
    }

    nearby.sort((a, b) => a.distanceMiles - b.distanceMiles)

    return res.json({
      ok: true,
      centerLat,
      centerLng,
      radiusMiles,
      records: nearby.map(({ mover, distanceMiles }) =>
        mapMoverToAirtableShape({ ...mover, _distanceMiles: distanceMiles })
      ),
    })
  } catch (err) {
    console.error("/api/movers/nearby error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Movers search ── */

app.get("/api/movers", async (req, res) => {
  try {
    const cityRaw  = String(req.query.city  || "").trim()
    const stateRaw = String(req.query.state || "").trim()
    const queryRaw = String(req.query.query || "").trim()

    const qRaw = queryRaw || [cityRaw, stateRaw].filter(Boolean).join(" ").trim()
    if (!qRaw) return res.json({ records: [] })

    let customerLat = null
    let customerLng = null
    const customerCity = (cityRaw || queryRaw).toLowerCase().trim()
try {
      const coords = await geocodeMoverAddress({
        city:  cityRaw  || queryRaw,
        state: stateRaw || "",
        zip:   "",
      })
      console.log("Geocoded successfully:", customerLat, customerLng)
      customerLat = coords.lat
      customerLng = coords.lng
    } catch (geoErr) {
      console.warn("Customer geocode failed, falling back to text search:", geoErr.message)
      console.warn("Query was:", cityRaw, stateRaw, queryRaw)
    }

    const { data: allMovers, error } = await supabase
      .from("movers")
      .select("*")
      .limit(500)

    if (error) return res.status(500).json({ error: "Failed to fetch movers" })

    if (customerLat !== null && customerLng !== null) {
      const scored = []

      for (const mover of allMovers) {
        const moverLat    = mover.lat
        const moverLng    = mover.lng
        const moverRadius = mover.service_radius_miles ?? 50

        if (!isFinite(moverLat) || !isFinite(moverLng)) {
          const textMatch =
            (mover.city  || "").toLowerCase().includes(customerCity) ||
            (mover.state || "").toLowerCase().includes(stateRaw.toLowerCase()) ||
            (mover.zip   || "").includes(queryRaw)
          if (textMatch) scored.push({ mover, dist: Infinity, exactCity: false })
          continue
        }

        const dist = haversineMiles(customerLat, customerLng, moverLat, moverLng)
        if (dist > moverRadius) continue

        const exactCity = (mover.city || "").toLowerCase().trim() === customerCity
        scored.push({ mover, dist, exactCity })
      }

      scored.sort((a, b) => {
        if (a.exactCity !== b.exactCity) return a.exactCity ? -1 : 1
        return a.dist - b.dist
      })

      const records = scored.map(({ mover, dist }) =>
        mapMoverToAirtableShape({
          ...mover,
          _distanceMiles: isFinite(dist) ? Math.round(dist * 10) / 10 : null,
        })
      )

      return res.json({ records })
    }

    // Fallback text search
    const qClean = qRaw.toLowerCase().trim()
    const filtered = allMovers.filter((m) =>
      (m.city  || "").toLowerCase().includes(qClean) ||
      (m.state || "").toLowerCase().includes(qClean) ||
      (m.name  || "").toLowerCase().includes(qClean) ||
      (m.zip   || "").includes(qClean)
    )

    return res.json({
      records: filtered.map((m) => mapMoverToAirtableShape(m)),
    })
  } catch (err) {
    console.error("/api/movers error:", err)
    return res.status(500).json({ error: "Server error" })
  }
})

/* ── Get mover by email ── */

app.get("/api/movers/by-email", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email)
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" })

    const { data: mover, error } = await supabase
      .from("movers")
      .select("*")
      .ilike("email", email)
      .maybeSingle()

    if (error || !mover) return res.status(404).json({ ok: false, error: "Not found" })

    return res.json({ ok: true, record: mapMoverToAirtableShape(mover) })
  } catch (err) {
    console.error("/api/movers/by-email error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Check mover availability ── */

app.get("/api/movers/:id/availability", async (req, res) => {
  try {
    const { id } = req.params
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" })

    // Check profiles first, then movers table
    let supabaseMoverId = null
    let moverPlan = "Free"

    const { data: profile } = await supabase
      .from("profiles")
      .select("id, plan")
      .eq("id", id)
      .maybeSingle()

    if (profile) {
      supabaseMoverId = profile.id
      moverPlan = profile.plan || "Free"
    } else {
      const { data: moverRow } = await supabase
        .from("movers")
        .select("email, plan")
        .eq("id", id)
        .maybeSingle()

      if (moverRow?.email) {
        const { data: profileByEmail } = await supabase
          .from("profiles")
          .select("id, plan")
          .ilike("email", moverRow.email)
          .maybeSingle()
        if (profileByEmail) {
          supabaseMoverId = profileByEmail.id
          moverPlan = profileByEmail.plan || "Free"
        }
      }
    }

    if (moverPlan !== "Free") return res.json({ ok: true, available: true })
    if (!supabaseMoverId) return res.json({ ok: true, available: true })

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()

    const { count } = await supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("mover_id", supabaseMoverId)
      .gte("created_at", monthStart)
      .lt("created_at", monthEnd)

    return res.json({ ok: true, available: count < 1, plan: moverPlan })
  } catch (err) {
    console.error("/api/movers/:id/availability error:", err)
    return res.json({ ok: true, available: true })
  }
})

/* ── Single mover by ID ── */

app.get("/api/movers/:id", async (req, res) => {
  try {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: "Missing id" })

    const { data: mover, error } = await supabase
      .from("movers")
      .select("*")
      .eq("id", id)
      .maybeSingle()

    if (error || !mover) return res.status(404).json({ error: "Mover not found" })

    return res.json({ record: mapMoverToAirtableShape(mover) })
  } catch (err) {
    console.error("movers/:id error:", err)
    return res.status(404).json({ error: "Mover not found" })
  }
})

/* ── Update listing fields from dashboard ── */

app.post("/api/update-listing", async (req, res) => {
  try {
    const { email, description, features, service_areas, services, response_time, website } = req.body || {}

    if (!email) return res.status(400).json({ ok: false, error: "Missing email" })

    const updates = {}
    if (description !== undefined && description !== "") updates.description = description
    if (features !== undefined) updates.features = Array.isArray(features) ? features.join(",") : features
    if (service_areas !== undefined && service_areas !== "") updates.service_areas = service_areas
    if (services !== undefined) updates.services = Array.isArray(services) ? services.join(",") : services
    if (response_time !== undefined && response_time !== "") updates.response_time = response_time
    if (website !== undefined && website !== "") updates.website = website

    const { error } = await supabase
      .from("movers")
      .update(updates)
      .ilike("email", normalizeEmail(email))

    if (error) {
      console.error("update-listing error:", error)
      return res.status(500).json({ ok: false, error: error.message })
    }

    console.log("✅ Updated movers listing for:", email)
    return res.json({ ok: true })
  } catch (err) {
    console.error("/api/update-listing error:", err?.message || err)
    return res.status(500).json({ ok: false, error: err?.message || "Server error" })
  }
})

/* ── Mover Dashboard ── */

app.get("/api/mover-dashboard", async (req, res) => {
  try {
    const rawEmail = req.query.email
    if (!rawEmail) return res.status(400).json({ ok: false, error: "Missing email" })

    const email = normalizeEmail(rawEmail)

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", email)
      .maybeSingle()

    if (error) return res.status(500).json({ ok: false, error: "Profile lookup failed" })
    if (!profile) return res.status(404).json({ ok: false, error: "Profile not found" })

    const mover = mapProfileToMover(profile)
    const subscriptionTier = profile.plan || "Free"
    const nextPaymentDate = formatDateLabel(profile.current_period_end)

    return res.json({ ok: true, mover, subscriptionTier, nextPaymentDate })
  } catch (err) {
    console.error("mover-dashboard route error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Update profile ── */

app.post("/api/update-profile", async (req, res) => {
  try {
    const {
      email,
      full_name,
      business_name,
      phone_e164,
      city,
      state,
      zip,
      logo_url,
      starting_price,
      service_radius_miles,
    } = req.body

    if (!email) return res.status(400).json({ ok: false, error: "Missing email" })

    const normalizedEmail = normalizeEmail(email)

    const updates = {
      full_name,
      business_name,
      phone_e164,
      city,
      state,
      zip,
      logo_url,
      starting_price,
      service_radius_miles,
      updated_at: new Date().toISOString(),
    }

    Object.keys(updates).forEach((k) => {
      if (updates[k] === undefined) delete updates[k]
    })

    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("email", normalizedEmail)
      .select("*")
      .single()

    if (error || !data) {
      return res.status(500).json({ ok: false, error: "Failed to update profile" })
    }

    // Sync to movers table instead of Airtable
    setImmediate(() => {
      upsertSupabaseMoverFromProfile(data).catch((e) =>
        console.error("Movers sync failed:", e)
      )
    })

    const mover = mapProfileToMover(data)
    return res.json({ ok: true, mover, profileCompletion: mover.profileCompletion })
  } catch (err) {
    console.error("update-profile route error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Signup ── */

app.post("/api/signup", async (req, res) => {
  try {
    const {
      fullName,
      businessName,
      email,
      phoneE164,
      zipCode,
      password,
      smsOptIn,
      plan = "Free",
    } = req.body

    if (!email || !password) {
      return res.status(400).json({ ok: false, code: "MISSING_FIELDS", error: "Please enter an email and password." })
    }

    const normalizedEmail = normalizeEmail(email)

    const { data: existingProfile } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("email", normalizedEmail)
      .maybeSingle()

    if (existingProfile) {
      return res.status(400).json({ ok: false, code: "EMAIL_IN_USE", error: "An account with this email already exists. Please log in instead." })
    }

    const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
    })

    if (authErr || !authUser?.user) {
      const msg = String(authErr?.message || "").toLowerCase()
      const alreadyExists = msg.includes("already") || msg.includes("exists") || msg.includes("registered") || msg.includes("duplicate")
      return res.status(400).json({
        ok: false,
        code: alreadyExists ? "EMAIL_IN_USE" : "SIGNUP_FAILED",
        error: alreadyExists
          ? "This email already has a PackRocket account. Try logging in or using Forgot password."
          : "We couldn't create your account. Please try again.",
      })
    }

    const user = authUser.user

    const { error: upsertErr } = await supabase.from("profiles").upsert(
      {
        id: user.id,
        email: normalizedEmail,
        full_name: fullName || "",
        business_name: businessName || "",
        phone_e164: phoneE164 || "",
        zip: zipCode || "",
        sms_opt_in: !!smsOptIn,
        plan,
        status: "pending",
        approval_status: "pending",
      },
      { onConflict: "id" }
    )

    if (upsertErr) {
      try { await supabase.auth.admin.deleteUser(user.id) } catch {}
      return res.status(400).json({ ok: false, code: "PROFILE_UPSERT_FAILED", error: "We couldn't finish setting up your account. Please try again." })
    }

    const baseUrl = process.env.PUBLIC_URL || "https://packrocket.co"

    if (plan === "Free") {
      await supabase.from("profiles").update({ status: "active" }).eq("id", user.id)

      const { data: savedProfile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle()

      if (savedProfile) {
        await upsertSupabaseMoverFromProfile(savedProfile).catch((e) =>
          console.error("Movers sync on Free signup failed:", e)
        )
      }

      return res.json({ ok: true, url: `${baseUrl}/dashboard?email=${encodeURIComponent(normalizedEmail)}` })
    }

    let stripeCustomerId = null
    const { data: profileRow } = await supabase.from("profiles").select("stripe_customer_id").eq("id", user.id).maybeSingle()

    if (profileRow?.stripe_customer_id) {
      stripeCustomerId = profileRow.stripe_customer_id
    } else {
      const customer = await stripe.customers.create({
        email: normalizedEmail,
        name: fullName || businessName || normalizedEmail,
        metadata: { user_id: user.id, plan },
      })
      stripeCustomerId = customer.id
      await supabase.from("profiles").update({ stripe_customer_id: customer.id }).eq("id", user.id)
    }

    // Sync to movers table
    setImmediate(() => {
      upsertSupabaseMoverFromProfile({
        id: user.id,
        email: normalizedEmail,
        full_name: fullName || "",
        business_name: businessName || "",
        phone_e164: phoneE164 || "",
        zip: zipCode || "",
        city: "",
        state: "",
        logo_url: "",
        plan,
      }).catch((e) => console.error("Movers sync on paid signup failed:", e))
    })

    const planPath = plan === "Pro" ? "/pro" : plan === "Enterprise" ? "/enterprise" : "/starter"
    const priceId = PRICE_IDS[plan]

    if (!priceId) {
      return res.status(500).json({ ok: false, code: "STRIPE_PRICE_MISSING", error: `Stripe price ID not configured for plan: ${plan}.` })
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${baseUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}&email=${encodeURIComponent(normalizedEmail)}`,
      cancel_url: `${baseUrl}${planPath}?canceled=1`,
    })

    if (!session?.url) {
      return res.status(500).json({ ok: false, code: "STRIPE_URL_MISSING", error: "We couldn't start checkout. Please try again." })
    }

    return res.json({ ok: true, url: session.url })
  } catch (err) {
    console.error("Signup error:", err)
    return res.status(500).json({ ok: false, code: "SIGNUP_FAILED", error: `Signup failed: ${err?.message || String(err)}` })
  }
})

/* ── Login ── */

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ ok: false, error: "Missing fields" })

    const normalizedEmail = normalizeEmail(email)
    const { data, error } = await getSupabaseAuth().auth.signInWithPassword({ email: normalizedEmail, password })

    if (error || !data?.user) {
      const msg = String(error?.message || "").toLowerCase()
      const badCreds = msg.includes("invalid") || msg.includes("credentials") || msg.includes("password") || msg.includes("not found")
      return res.status(400).json({
        ok: false,
        error: badCreds ? "Incorrect email or password. Please try again." : "Login failed. Please try again.",
      })
    }

    return res.json({ ok: true, email: normalizedEmail, userId: data.user.id, accessToken: data.session?.access_token || "" })
  } catch (err) {
    console.error("Login route error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Stripe Billing Portal ── */

app.get("/api/stripe/manage-billing", async (req, res) => {
  try {
    const rawEmail = req.query.email
    if (!rawEmail) return res.status(400).json({ ok: false, error: "Missing email" })

    const email = normalizeEmail(rawEmail)
    const baseUrl = process.env.PUBLIC_URL || "https://packrocket.co"

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, stripe_customer_id, plan")
      .ilike("email", email)
      .single()

    if (error || !profile) return res.status(404).json({ ok: false, error: "Profile not found" })

    if (!profile.stripe_customer_id || profile.plan === "Free") {
      const priceId = PRICE_IDS.Pro
      if (!priceId) return res.status(500).json({ ok: false, error: "Pro price not configured" })

      let stripeCustomerId = profile.stripe_customer_id
      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({ email, metadata: { user_id: profile.id } })
        stripeCustomerId = customer.id
        await supabase.from("profiles").update({ stripe_customer_id: customer.id }).eq("id", profile.id)
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: priceId, quantity: 1 }],
        allow_promotion_codes: true,
        success_url: `${baseUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}&email=${encodeURIComponent(email)}`,
        cancel_url: `${baseUrl}/dashboard?email=${encodeURIComponent(email)}`,
      })

      return res.redirect(303, session.url)
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${baseUrl}/dashboard?email=${encodeURIComponent(email)}`,
    })

    return res.redirect(303, portalSession.url)
  } catch (err) {
    console.error("manage-billing route error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Cancel subscription ── */

app.post("/api/stripe/cancel-subscription", async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" })

    const { data: profile } = await supabase
      .from("profiles")
      .select("id, stripe_subscription_id, stripe_customer_id")
      .ilike("email", normalizeEmail(email))
      .single()

    if (!profile?.stripe_subscription_id) {
      return res.status(400).json({ ok: false, error: "No active subscription found" })
    }

    const updatedSub = await stripe.subscriptions.update(profile.stripe_subscription_id, { cancel_at_period_end: true })

    await supabase.from("profiles").update({
      status: "cancelling",
      stripe_subscription_id: updatedSub.id,
      current_period_end: new Date(updatedSub.current_period_end * 1000).toISOString(),
    }).eq("id", profile.id)

    return res.json({ ok: true, subscriptionId: updatedSub.id, current_period_end: new Date(updatedSub.current_period_end * 1000).toISOString() })
  } catch (err) {
    console.error("cancel-subscription error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ── Route proxy ── */

app.get("/api/route", async (req, res) => {
  try {
    const { fromLat, fromLng, toLat, toLng } = req.query
    if (!fromLat || !fromLng || !toLat || !toLng) {
      return res.status(400).json({ error: "Missing coordinates" })
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=false`
    const response = await fetch(url, { headers: { "User-Agent": "PackRocket/1.0" } })

    if (!response.ok) throw new Error(`OSRM error: ${response.status}`)

    const data = await response.json()
    if (data.code !== "Ok" || !data.routes?.[0]?.geometry?.coordinates?.length) {
      throw new Error("No route returned")
    }

    const coordinates = data.routes[0].geometry.coordinates.map((c) => [c[1], c[0]])
    return res.json({ coordinates })
  } catch (err) {
    console.error("/api/route error:", err?.message)
    return res.status(500).json({ error: "Routing failed" })
  }
})

/* ── Debug ── */

app.get("/api/_debug", (_req, res) => {
  res.json({
    cwd: process.cwd(),
    stripeKeyPrefix: (process.env.STRIPE_SECRET_KEY || "").slice(0, 8),
    prices: PRICE_IDS,
    supabaseConfigured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    logoBucket: LOGO_BUCKET,
    airtable: "REMOVED — all data now in Supabase movers table",
  })
})

app.listen(PORT, () => {
  console.log(`✅ PackRocket API running on :${PORT}`)
})