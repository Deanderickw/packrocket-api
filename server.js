/* ========= PackRocket API — Express + Supabase + Stripe + Airtable ========= */
const express = require("express")
const cors = require("cors")
const Stripe = require("stripe")
const { createClient } = require("@supabase/supabase-js")
const Airtable = require("airtable")
require("dotenv").config()

const PORT = process.env.PORT || 5050
const app = express() // ✅ Express app

/* ------------------------- init clients ------------------------- */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
})

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

/* ------------------------- Airtable setup ------------------------- */

let airtableBase = null
if (process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID) {
  airtableBase = new Airtable({
    apiKey: process.env.AIRTABLE_API_KEY,
  }).base(process.env.AIRTABLE_BASE_ID)
} else {
  console.log("⚠️ Airtable not fully configured (API key or Base ID missing)")
}

const moversTableName = process.env.AIRTABLE_TABLE_NAME || "Movers"

const moversTable = () => {
  if (!airtableBase) return null
  return airtableBase(moversTableName)
}

/* ------------------------- helpers ------------------------- */

// Compute profile completion (0–100%)
function computeProfileCompletion(profile) {
  if (!profile) return 0

  const fields = [
    profile.full_name,
    profile.business_name,
    profile.phone_e164,
    profile.city,
    profile.state,
    profile.logo_url,
    // You *could* include profile.starting_price here if you want it in completion
  ]

  const filled = fields.filter((v) => v && String(v).trim() !== "").length
  const total = fields.length || 1

  return Math.round((filled / total) * 100)
}

// Format date nicely for dashboard
function formatDateLabel(isoOrMillis) {
  if (!isoOrMillis) return "N/A"

  let date
  if (typeof isoOrMillis === "number") {
    // Unix timestamp in seconds
    date = new Date(isoOrMillis * 1000)
  } else {
    date = new Date(isoOrMillis)
  }

  if (isNaN(date.getTime())) return "N/A"

  const options = { month: "short", day: "numeric", year: "numeric" }
  return date.toLocaleDateString("en-US", options) // e.g. "Nov 30, 2025"
}

// Map Supabase 'profiles' row into the Mover shape your Framer component expects
function mapProfileToMover(profileRow) {
  if (!profileRow) return {}

  return {
    id: profileRow.id,
    name: profileRow.full_name || profileRow.business_name || "Mover",
    email: profileRow.email || "",
    phone: profileRow.phone_e164 || "",
    city: profileRow.city || "",
    state: profileRow.state || "",
    logo: profileRow.logo_url || "",
    verified: true, // tweak later if you want real verification
    rating: 4.9, // placeholder
    jobsCompleted: 0, // placeholder
    // 👇 force it to a Number if it exists
    startingPrice:
      profileRow.starting_price !== null &&
      profileRow.starting_price !== undefined &&
      profileRow.starting_price !== ""
        ? Number(profileRow.starting_price)
        : undefined,
    features: [],
    profileCompletion: computeProfileCompletion(profileRow),
  }
}


// ✅ Single, clean Airtable sync helper
async function upsertAirtableMoverFromProfile(profileRow) {
  try {
    const table = moversTable()

    if (
      !process.env.AIRTABLE_API_KEY ||
      !process.env.AIRTABLE_BASE_ID ||
      !moversTableName ||
      !table
    ) {
      console.log("Airtable env not fully set or table missing, skipping sync")
      return
    }

    if (!profileRow || !profileRow.email) {
      console.log("No profileRow or email passed to upsertAirtableMoverFromProfile")
      return
    }

    const email = profileRow.email
    const name =
      profileRow.business_name ||
      profileRow.full_name ||
      "Mover"

    const phone = profileRow.phone_e164 || ""
    const city = profileRow.city || ""
    const state = profileRow.state || ""
    const logoUrl = profileRow.logo_url || ""
    const plan = profileRow.plan || "Starter"
    const startingPrice = profileRow.starting_price || null

    // 🔍 Look up existing row by Email
    const records = await table
      .select({
        filterByFormula: `{Email} = "${email}"`,
        maxRecords: 1,
      })
      .firstPage()

    const fields = {
      Email: email,
      Name: name,
      Phone: phone,
      City: city,
      State: state,
      Plan: plan,
    }

    if (logoUrl) {
      fields.Logo = [{ url: logoUrl }]
    }

    if (startingPrice !== null) {
      // Airtable field will auto-create if it doesn't exist
      fields["Starting price"] = startingPrice
    }

    if (records.length > 0) {
      // ✏️ Update existing row
      await table.update([
        {
          id: records[0].id,
          fields,
        },
      ])
      console.log("✅ Updated Airtable mover row for:", email)
    } else {
      // ➕ Create new row
      await table.create([{ fields }])
      console.log("✅ Created Airtable mover row for:", email)
    }
  } catch (err) {
    console.error("Airtable sync failed:", err)
    // Don’t throw – never block signup/dashboard because of Airtable
  }
}

/* ------------------------- Stripe price IDs ------------------------- */

const PRICE_IDS = {
  Starter: process.env.STRIPE_PRICE_STARTER,
  Pro: process.env.STRIPE_PRICE_PRO,
  Enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
}

/* ------------------------- CORS (top-level) ------------------------- */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
)

/* ---------- STRIPE WEBHOOK: must be BEFORE express.json and use RAW body --- */

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
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

    try {
      // checkout completed → activate profile
      if (event.type === "checkout.session.completed") {
        const session = event.data.object
        const customerId = session.customer

        const { data: user } = await supabase
          .from("profiles")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .single()

        if (user) {
          await supabase
            .from("profiles")
            .update({ status: "active" })
            .eq("id", user.id)

          console.log("✅ Profile activated for customer:", customerId)
        }
      }

      // subscription updates
      if (event.type === "customer.subscription.updated") {
        const sub = event.data.object

        const { data: user } = await supabase
          .from("profiles")
          .select("id")
          .eq("stripe_customer_id", sub.customer)
          .single()

        if (user) {
          await supabase
            .from("profiles")
            .update({
              stripe_subscription_id: sub.id,
              current_period_end: new Date(
                sub.current_period_end * 1000
              ).toISOString(),
            })
            .eq("id", user.id)

          console.log("🔄 Subscription updated for:", sub.customer)
        }
      }

      return res.sendStatus(200)
    } catch (err) {
      console.error("⚠️ Webhook handler error:", err)
      return res.status(500).send("Server Error")
    }
  }
)

/* --------------------- JSON middleware for normal routes ------------------ */

app.use(express.json()) // ✅ after webhook

/* ----------------------------- Health check ------------------------------- */

app.get("/api/health", (_req, res) => res.json({ ok: true }))

/* ----------------------------- Debug route -------------------------------- */

app.get("/api/_debug", (_req, res) => {
  res.json({
    cwd: process.cwd(),
    stripeKeyPrefix: (process.env.STRIPE_SECRET_KEY || "").slice(0, 8),
    prices: PRICE_IDS,
    airtableConfigured: !!(
      process.env.AIRTABLE_API_KEY &&
      process.env.AIRTABLE_BASE_ID &&
      moversTableName
    ),
  })
})

/* ------------------- Mover Dashboard route (by email) --------------------- */

// GET /api/mover-dashboard?email=someone@example.com
app.get("/api/mover-dashboard", async (req, res) => {
  try {
    const email = req.query.email

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing email" })
    }

    // Get the mover profile from Supabase 'profiles' table
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", email)
      .single()

    if (error) {
      console.error("Supabase profile error:", error)

      // If no rows found, respond as "not found" instead of 500
      if (error.code === "PGRST116") {
        return res.status(404).json({ ok: false, error: "Profile not found" })
      }

      return res.status(500).json({ ok: false, error: "Profile lookup failed" })
    }

    if (!profile) {
      return res.status(404).json({ ok: false, error: "Profile not found" })
    }

    const mover = mapProfileToMover(profile)
    const subscriptionTier = profile.plan || "Starter"
    const nextPaymentDate = formatDateLabel(profile.current_period_end)

    return res.json({
      ok: true,
      mover,
      subscriptionTier,
      nextPaymentDate,
    })
  } catch (err) {
    console.error("mover-dashboard route error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* -------------------------- Update profile route -------------------------- */

app.post("/api/update-profile", async (req, res) => {
  try {
    const {
      email, // required
      full_name,
      business_name,
      phone_e164,
      city,
      state,
      logo_url,
      starting_price, // 👈 NEW
    } = req.body

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing email" })
    }

    const updates = {
      full_name,
      business_name,
      phone_e164,
      city,
      state,
      logo_url,
      starting_price, // 👈 NEW
      updated_at: new Date().toISOString(),
    }

    // Remove undefined so we don't overwrite with null
    Object.keys(updates).forEach((k) => {
      if (updates[k] === undefined) delete updates[k]
    })

    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("email", email)
      .select("*")
      .single()

    if (error || !data) {
      console.error("update-profile supabase error:", error)
      return res
        .status(500)
        .json({ ok: false, error: "Failed to update profile" })
    }

    // ✅ Keep Airtable "Movers" row in sync with this profile
    await upsertAirtableMoverFromProfile(data)

    const mover = mapProfileToMover(data)

    res.json({
      ok: true,
      mover,
      profileCompletion: mover.profileCompletion,
    })
  } catch (err) {
    console.error("update-profile route error:", err)
    res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ----------------------------- Signup route ------------------------------- */

app.post("/api/signup", async (req, res) => {
  try {
    const {
      fullName,
      businessName,
      email,
      phoneE164,
      password,
      smsOptIn,
      plan = "Starter",
    } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: "Missing required fields" })
    }

    // 1) Create auth user
    const { data: authUser, error: authErr } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })

    if (authErr || !authUser?.user) {
      console.error("Supabase auth error:", authErr)
      return res.status(400).json({ error: "Auth create failed" })
    }

    const user = authUser.user

    // 2) Insert profile
    const { error: insertErr } = await supabase.from("profiles").insert({
      id: user.id,
      email,
      full_name: fullName || "",
      business_name: businessName || "",
      phone_e164: phoneE164 || "",
      sms_opt_in: !!smsOptIn,
      plan,
      status: "pending", // allowed
    })

    if (insertErr) {
      console.error("Supabase insert error:", insertErr)
      return res.status(400).json({ error: insertErr.message })
    }

    // 2.5) Sync to Airtable movers table (basic fields)
    await upsertAirtableMoverFromProfile({
      id: user.id,
      email,
      full_name: fullName || "",
      business_name: businessName || "",
      phone_e164: phoneE164 || "",
      city: "",
      state: "",
      logo_url: "",
      plan,
      // starting_price not set at signup yet
    })

    // 3) Stripe customer
    const customer = await stripe.customers.create({
      email,
      name: fullName || businessName || email,
      metadata: { user_id: user.id, plan },
    })

    await supabase
      .from("profiles")
      .update({ stripe_customer_id: customer.id })
      .eq("id", user.id)

    // 4) Checkout session
    const baseUrl =
      process.env.PUBLIC_URL ||
      "https://fortuitous-book-118427.framer.app"

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [
        { price: PRICE_IDS[plan] || PRICE_IDS.Starter, quantity: 1 },
      ],
      success_url: `${baseUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}&email=${encodeURIComponent(
        email
      )}`,
      cancel_url: `${baseUrl}/signup?canceled=1`,
    })

    return res.json({ url: session.url })
  } catch (err) {
    console.error("Signup error:", err)
    return res.status(500).json({ error: "Signup failed" })
  }
})

/* --------------------- Stripe Billing Portal (manage) --------------------- */

// GET /api/stripe/manage-billing?email=someone@example.com
app.get("/api/stripe/manage-billing", async (req, res) => {
  try {
    const email = req.query.email
    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing email" })
    }

    // Look up profile by email to get Stripe customer id
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, stripe_customer_id")
      .eq("email", email)
      .single()

    if (error) {
      console.error("manage-billing supabase error:", error)
      return res
        .status(500)
        .json({ ok: false, error: "Profile lookup failed" })
    }

    if (!profile || !profile.stripe_customer_id) {
      return res
        .status(404)
        .json({ ok: false, error: "No Stripe customer for this email" })
    }

    const baseUrl =
      process.env.PUBLIC_URL ||
      "https://fortuitous-book-118427.framer.app"

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${baseUrl}/dashboard?email=${encodeURIComponent(email)}`,
    })

    // redirect straight to Stripe portal (so window.open works)
    return res.redirect(303, portalSession.url)
  } catch (err) {
    console.error("manage-billing route error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* ---------------------- Cancel subscription (Stripe) ---------------------- */

// POST /api/stripe/cancel-subscription  { email }
app.post("/api/stripe/cancel-subscription", async (req, res) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing email" })
    }

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, stripe_subscription_id, stripe_customer_id")
      .eq("email", email)
      .single()

    if (error) {
      console.error("cancel-subscription supabase error:", error)
      return res
        .status(500)
        .json({ ok: false, error: "Profile lookup failed" })
    }

    if (!profile || !profile.stripe_subscription_id) {
      return res.status(400).json({
        ok: false,
        error: "No active subscription found for this user",
      })
    }

    // Set cancel at period end (they keep access until current period ends)
    const updatedSub = await stripe.subscriptions.update(
      profile.stripe_subscription_id,
      { cancel_at_period_end: true }
    )

    // Save latest info back to Supabase
    await supabase
      .from("profiles")
      .update({
        status: "cancelling",
        stripe_subscription_id: updatedSub.id,
        current_period_end: new Date(
          updatedSub.current_period_end * 1000
        ).toISOString(),
      })
      .eq("id", profile.id)

    return res.json({
      ok: true,
      subscriptionId: updatedSub.id,
      current_period_end: new Date(
        updatedSub.current_period_end * 1000
      ).toISOString(),
    })
  } catch (err) {
    console.error("cancel-subscription route error:", err)
    return res.status(500).json({ ok: false, error: "Server error" })
  }
})

/* --------------------------------- Start ---------------------------------- */

app.listen(PORT, () => {
  console.log(`✅ PackRocket API running on :${PORT}`)
})
