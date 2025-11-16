/* ========= PackRocket API — Express + Supabase + Stripe + Airtable ========= */
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const Airtable = require('airtable');
require('dotenv').config();

const PORT = process.env.PORT || 5050;
const app = express();

/* ------------------------- init clients ------------------------- */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
// --- Helper to format dates nicely for the dashboard ---
function formatDateLabel(isoOrMillis) {
  if (!isoOrMillis) return "N/A"

  let date
  if (typeof isoOrMillis === "number") {
    date = new Date(isoOrMillis * 1000) // if it's a Unix timestamp in seconds
  } else {
    date = new Date(isoOrMillis)
  }

  if (isNaN(date.getTime())) return "N/A"

  const options = { month: "short", day: "numeric", year: "numeric" }
  return date.toLocaleDateString("en-US", options) // e.g. "Nov 30, 2025"
}

// --- Map Supabase 'profiles' row into the Mover shape your Framer component expects ---
function mapProfileToMover(profileRow) {
  if (!profileRow) return {}

  return {
    id: profileRow.id,
    name: profileRow.full_name || profileRow.business_name || "Mover",
    email: profileRow.email || "",
    phone: profileRow.phone_e164 || "",
    // city/state/logo/etc will eventually come from Airtable
    city: "",
    state: "",
    verified: true, // you can change this later
    rating: 4.9,
    jobsCompleted: 0,
    startingPrice: undefined,
    features: [],
  }
}

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID || ''
);
const moversTable = () => airtable.table(process.env.AIRTABLE_TABLE_NAME || 'Movers');

const PRICE_IDS = {
  Starter: process.env.STRIPE_PRICE_STARTER,
  Pro: process.env.STRIPE_PRICE_PRO,
  Enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

/* ------------------------- CORS (top-level) ------------------------- */
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

/* ---------- STRIPE WEBHOOK: must be BEFORE express.json and use RAW body --- */
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
// GET /api/mover-dashboard?email=dean@example.com
app.get("/api/mover-dashboard", async (req, res) => {
  try {
    const email = req.query.email

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing email" })
    }

    // Get the mover profile from Supabase 'profiles' table
    const { data: profile, error } = await supabase
      .from("profiles")            // ⬅️ IMPORTANT: table name is 'profiles'
      .select("*")
      .eq("email", email)
      .single()

    if (error) {
      console.error("Supabase profile error:", error)
      return res.status(500).json({ ok: false, error: "Profile lookup failed" })
    }

    if (!profile) {
      return res.status(404).json({ ok: false, error: "Profile not found" })
    }

    const mover = mapProfileToMover(profile)

    // Plan + next payment date from your columns
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

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Webhook signature error:', err.message);
      return res.status(400).send('Webhook Error');
    }

    try {
      // checkout completed → activate profile
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerId = session.customer;

        const { data: user } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (user) {
          await supabase
            .from('profiles')
            .update({ status: 'active' })
            .eq('id', user.id);

          console.log('✅ Profile activated for customer:', customerId);
        }
      }

      // subscription updates
      if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;

        const { data: user } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', sub.customer)
          .single();

        if (user) {
          await supabase
            .from('profiles')
            .update({
              stripe_subscription_id: sub.id,
              current_period_end: new Date(
                sub.current_period_end * 1000
              ).toISOString(),
            })
            .eq('id', user.id);

          console.log('🔄 Subscription updated for:', sub.customer);
        }
      }

      return res.sendStatus(200);
    } catch (err) {
      console.error('⚠️ Webhook handler error:', err);
      return res.status(500).send('Server Error');
    }
  }
);

/* --------------------- JSON middleware for normal routes ------------------ */
app.use(express.json()); // ✅ after webhook

/* ----------------------------- Health check ------------------------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* ----------------------------- Debug route -------------------------------- */
app.get('/api/_debug', (_req, res) => {
  res.json({
    cwd: process.cwd(),
    stripeKeyPrefix: (process.env.STRIPE_SECRET_KEY || '').slice(0, 8),
    prices: PRICE_IDS,
  });
});

/* ----------------------------- Signup route ------------------------------- */
app.post('/api/signup', async (req, res) => {
  try {
    const {
      fullName,
      businessName,
      email,
      phoneE164,
      password,
      smsOptIn,
      plan = 'Starter',
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
app.get("/api/dashboard-profile", async (req, res) => {
  try {
    const { session_id } = req.query
    if (!session_id) {
      return res.status(400).json({ error: "Missing session_id" })
    }

    // Get Stripe checkout session
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["customer"],
    })

    const email =
      session.customer_details?.email ||
      (session.customer && session.customer.email)

    if (!email) {
      return res.status(404).json({ error: "No email on session" })
    }

    // Look up mover profile in Supabase by email
    const { data, error } = await supabase
      .from("movers") // change to your actual table name if different
      .select("*")
      .eq("email", email)
      .single()

    if (error || !data) {
      return res.status(404).json({ error: "Profile not found" })
    }

    // Optional: compute next payment date from subscription
    let nextPaymentDate = null
    if (session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription
      )
      if (subscription.current_period_end) {
        const d = new Date(subscription.current_period_end * 1000)
        nextPaymentDate = d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      }
    }

    const profile = {
      ...data,
      nextPaymentDate,
      subscriptionTier: data.plan || data.subscriptionTier || "Starter",
    }

    res.json({ profile })
  } catch (err) {
    console.error("dashboard-profile error:", err)
    res.status(500).json({ error: "Server error" })
  }
})
app.post("/api/update-profile", async (req, res) => {
  try {
    const { session_id, name, city, state, phone } = req.body
    if (!session_id) {
      return res.status(400).json({ error: "Missing session_id" })
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["customer"],
    })

    const email =
      session.customer_details?.email ||
      (session.customer && session.customer.email)

    if (!email) {
      return res.status(404).json({ error: "No email on session" })
    }

    const updates = {
      name,
      city,
      state,
      phone,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from("movers") // change if your table name is different
      .update(updates)
      .eq("email", email)
      .select("*")
      .single()

    if (error || !data) {
      console.error("update-profile error:", error)
      return res.status(500).json({ error: "Failed to update profile" })
    }

    res.json({ ok: true, profile: data })
  } catch (err) {
    console.error("update-profile error:", err)
    res.status(500).json({ error: "Server error" })
  }
})

    // 1) create auth user
    const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authErr || !authUser?.user) {
      console.error('Supabase auth error:', authErr);
      return res.status(400).json({ error: 'Auth create failed' });
    }

    const user = authUser.user;

    // 2) insert profile
    const { error: insertErr } = await supabase.from('profiles').insert({
      id: user.id,
      email,
      full_name: fullName || '',
      business_name: businessName || '',
      phone_e164: phoneE164 || '',
      sms_opt_in: !!smsOptIn,
      plan,
      status: 'pending', // now allowed because we made status text
    });

    if (insertErr) {
      console.error('Supabase insert error:', insertErr);
      return res.status(400).json({ error: insertErr.message });
    }

    // 3) Stripe customer
    const customer = await stripe.customers.create({
      email,
      name: fullName || businessName || email,
      metadata: { user_id: user.id, plan },
    });

    await supabase
      .from('profiles')
      .update({ stripe_customer_id: customer.id })
      .eq('id', user.id);

    // 4) Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: PRICE_IDS[plan] || PRICE_IDS.Starter, quantity: 1 }],
      success_url: `${process.env.PUBLIC_URL || 'https://fortuitous-book-118427.framer.app'}/dashboard?session_id={CHECKOUT_SESSION_ID`,
      cancel_url: `${process.env.PUBLIC_URL || 'http://localhost:5050'}/signup?canceled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {c
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Signup failed' });
  }
});

/* --------------------------------- Start ---------------------------------- */
app.listen(PORT, () => {
  console.log(`✅ PackRocket API running on :${PORT}`);
});

