---
name: weather
description: Fetch current weather and 3-day forecast for a city using Open-Meteo. Default city: Belgrade. Metric units. Brief output by default; say "detailed" or "full" for expanded. Use when the user asks about weather, temperature, forecast, or says "weather in X".
---

# /weather — Weather Forecast

Fetch weather for a city and reply with a concise, Telegram-friendly report.

## 1. Extract the city

Read the user's message to find the city name. Examples:
- "weather in Belgrade" → Belgrade
- "what's the weather in Paris?" → Paris
- "weather" or "/weather" → Belgrade (default)

## 2. Geocode the city

The geocache file lives at `/workspace/group/.weather_geocache.json` — a JSON object mapping lowercase city names to `{name, latitude, longitude}`.

**Check cache first:**

```bash
cat /workspace/group/.weather_geocache.json 2>/dev/null || echo "{}"
```

Look up the city by its lowercase name (e.g. `"tel aviv"`). If found, use the cached `latitude`, `longitude`, and `name` — skip the API call.

**If not cached**, URL-encode the city name (spaces and hyphens → `+`) and fetch:

```bash
curl "https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1"
```

If `results` is empty, retry once with hyphens replaced by spaces (e.g. "Tel-Aviv" → "Tel Aviv").

If still empty, reply:
> ❌ City not found: {city}. Check the spelling and try again.

Extract `results[0].latitude`, `results[0].longitude`, and `results[0].name` (canonical city name).

**Save to cache:**

```bash
# Read existing cache (or empty object), add the new entry, write back
node -e "
const fs = require('fs');
const f = '/workspace/group/.weather_geocache.json';
const cache = JSON.parse(fs.existsSync(f) ? fs.readFileSync(f,'utf8') : '{}');
cache['{city_lowercase}'] = {name:'{canonical_name}', latitude:{lat}, longitude:{lon}};
fs.writeFileSync(f, JSON.stringify(cache, null, 2));
"
```

Replace `{city_lowercase}` with the lowercase input city name, `{canonical_name}` with `results[0].name`, and `{lat}` / `{lon}` with the coordinates.

## 3. Fetch weather and air quality

Run both in parallel:

```bash
curl "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation,weather_code,pressure_msl,uv_index&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,rain_sum,snowfall_sum,precipitation_probability_max,uv_index_max,sunrise,sunset,wind_speed_10m_max,weather_code&timezone=auto&forecast_days=3"

curl "https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,european_aqi&hourly=european_aqi,pm10,pm2_5&timezone=auto&forecast_days=3"
```

Replace `{lat}` and `{lon}` with the values from step 2.

## 4. Parse and format

**Current conditions** — find the index in `hourly.time` that matches the current hour (e.g. `2026-03-22T10:00`), then read from weather `hourly` arrays at that index:
- `temperature_2m[i]` — current temperature (°C)
- `apparent_temperature[i]` — feels like (°C)
- `relative_humidity_2m[i]` — humidity (%)
- `precipitation[i]` — precipitation this hour (mm)
- `pressure_msl[i]` — pressure (hPa)
- `wind_speed_10m[i]` — wind speed (km/h)
- `uv_index[i]` — UV index
- `weather_code[i]` — WMO code (see icon mapping below)

**Air quality** — from air quality `current` (real-time):
- `european_aqi` — European AQI index (0–20 Good, 20–40 Fair, 40–60 Moderate, 60–80 Poor, 80–100 Very Poor, 100+ Extremely Poor)
- `pm2_5` — PM2.5 (µg/m³)
- `pm10` — PM10 (µg/m³)
- `nitrogen_dioxide` — NO₂ (µg/m³)
- `ozone` — O₃ (µg/m³)
- `carbon_monoxide` — CO (µg/m³)

AQI emoji: 🟢 Good (0–20) · 🟡 Fair (20–40) · 🟠 Moderate (40–60) · 🔴 Poor (60–80) · 🟣 Very Poor (80–100) · ⚫ Extremely Poor (100+)

**Daily forecast** — from `daily` arrays (indices 0 = today, 1 = tomorrow, 2 = day after):
- `time[i]` — date (YYYY-MM-DD)
- `temperature_2m_max[i]` / `temperature_2m_min[i]` — high/low (°C)
- `precipitation_probability_max[i]` — rain chance (%)
- `rain_sum[i]` — rain (mm)
- `snowfall_sum[i]` — snow (cm)
- `uv_index_max[i]` — UV index
- `sunrise[i]` / `sunset[i]` — sunrise/sunset (format: HH:MM)
- `weather_code[i]` — WMO code

**Daily AQI** — from air quality `hourly` arrays, compute the max `european_aqi` for each calendar day (group by date prefix of `hourly.time`). This gives one peak AQI value per forecast day to show alongside the weather forecast.

## 5. Generate advice

Write one short sentence of practical advice based on the full picture: current conditions, 3-day forecast, and AQI. Consider what actually matters — rain, extreme cold/heat, high wind, poor air quality, UV, snow. Pick the most actionable insight.

Examples:
- "Umbrella recommended — 80% rain chance Monday, and air quality stays poor through the week."
- "Great day to be outside — clear skies, UV peaks at 4, air quality good all day."
- "Air quality is poor today (AQI 72), consider limiting outdoor activity especially in the morning."
- "Warm and dry through Tuesday, then rain and snow hit Wednesday — plan accordingly."

Keep it to one sentence. No filler like "Have a nice day!".

## 6. Output format

Use **brief** by default. Switch to **expanded** if the user says "detailed", "full", "more info", or similar.

### Brief (default)

```
☁️ *Belgrade — Sun, 22 Mar 2026, 10:00 CET*
🌡 10.5°C (feels 5.6°C) · 💨 22 km/h · 🟠 AQI 53

📅 *Forecast*
• Today:  14° / 8°  ☁️  Rain 2%   🟠 56
• Sun:    15° / 7°  ☁️  Rain 1%   🟡 34
• Mon:    16° / 8°  ☁️  Rain 14%  🔴 62

💡 _Air quality is moderate today — fine for outdoor activities, but sensitive groups should take care._
```

### Expanded

```
🌤 *Weather in Belgrade*
_Sun, 22 Mar 2026, 10:00 CET — Partly cloudy_

🌡 *14°C* (feels like 12°C)
💧 Humidity: 65% · 🌧 Precip: 0.2mm
💨 Wind: 15 km/h · 🔵 Pressure: 1013 hPa
☀️ UV: 3.3

🟢 *Air Quality: 12 (Good)*
PM2.5: 4.1 · PM10: 6.2 · NO₂: 8.3 · O₃: 52.1 · CO: 180

🌅 Sunrise 06:28 · Sunset 18:44

📅 *3-Day Forecast*
• Today (Sun):   14° / 8°  🌤 Rain: 20%  UV: 4  🟢 AQI: 18
• Mon:           17° / 10° ⛅ Rain: 5%   UV: 3  🟠 AQI: 45
• Tue:           12° / 7°  🌧 Rain: 80%  UV: 2  🔴 AQI: 72  Snow: 1cm

💡 _Umbrella recommended Monday — 80% rain chance, and air quality worsens to poor by Tuesday._
```

**Rules:**
- **Language:** Reply in the same language the user used to ask about the weather. If the request is in Russian, reply in Russian (city name, advice, day names, descriptions — everything). If English, reply in English. Match any other language the same way. Only the emoji and numbers stay the same.
- Use Telegram Markdown: `*bold*` for headers, `_italic_` for description
- Omit snow if `snowfall_sum` is 0
- If AQI data is missing for a forecast day, show `AQI: N/A` in that row
- If the air quality API call fails entirely, replace the AQI section with: `🌫 *Air Quality: unavailable*`

## WMO weather code → emoji

| Code(s) | Icon | Description |
|---------|------|-------------|
| 0 | ☀️ | Clear sky |
| 1, 2 | 🌤 | Mainly clear / Partly cloudy |
| 3 | ☁️ | Overcast |
| 45, 48 | 🌫 | Fog |
| 51, 53, 55 | 🌦 | Drizzle |
| 61, 63, 65 | 🌧 | Rain |
| 71, 73, 75 | ❄️ | Snow |
| 77 | 🌨 | Snow grains |
| 80, 81, 82 | 🌧 | Rain showers |
| 85, 86 | ❄️ | Snow showers |
| 95 | ⛈ | Thunderstorm |
| 96, 99 | ⛈ | Thunderstorm with hail |
