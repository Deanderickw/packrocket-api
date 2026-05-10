require("dotenv").config()
const Airtable = require("airtable")
const base = new Airtable({ apiKey: process.env.AIRTABLE_PAT })
  .base(process.env.AIRTABLE_BASE_ID)
const table = base("Movers")

async function geocode(city, state, zip) {
  const q = [city, state, zip].filter(Boolean).join(" ")
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=us&format=json&limit=1`,
    { headers: { "User-Agent": "PackRocket/1.0" } }
  )
  const d = await res.json()
  if (!d?.[0]) return null
  return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
}

async function run() {
  const records = []
  await table.select({ maxRecords: 500 }).eachPage((recs, next) => {
    records.push(...recs)
    next()
  })

  for (const rec of records) {
    const { City, State, ZIP, Lat, Lng } = rec.fields
    if (Lat && Lng) { console.log("skip (has coords):", rec.fields.Name); continue }
    if (!City && !State && !ZIP) { console.log("skip (no address):", rec.fields.Name); continue }

    const coords = await geocode(City, State, ZIP)
    if (!coords) { console.warn("no result for:", rec.fields.Name); continue }

   await table.update([{ id: rec.id, fields: { 
  "Lat": coords.lat,
  "Lng": coords.lng
} }])
    console.log(`✅ ${rec.fields.Name}: ${coords.lat}, ${coords.lng}`)

    await new Promise(r => setTimeout(r, 1100))
  }
  console.log("Done!")
}

run().catch(console.error)