//! RFC 3339 timestamp handling at the file boundary, replacing the
//! JavaScript `Date.parse` / `toISOString` pair. The supported file form is
//! fixed: `YYYY-MM-DDTHH:MM:SS(.fraction)?(Z|±HH:MM)`; the canonical output
//! form is the UTC `Z` shape with exactly three fractional digits (the
//! `toISOString` shape).

use refino_core::RefinoError;

/// Whether the value is a valid premise `confirmed` timestamp in its file form.
pub fn is_valid_confirmed(value: &str) -> bool {
    parse_rfc3339_ms(value).is_some()
}

/// The file's RFC 3339 `confirmed` form as epoch milliseconds. `None` when
/// the value does not parse (callers validate first via `is_valid_confirmed`
/// and report an issue instead).
pub fn confirmed_to_ms(value: &str) -> Option<i64> {
    parse_rfc3339_ms(value)
}

/// The epoch-millisecond `confirmed` form as the file's RFC 3339 form (UTC,
/// `Z` offset, `toISOString` shape). Errors on a non-finite input.
pub fn confirmed_to_rfc3339(ms: i64) -> Result<String, RefinoError> {
    // i64 has no NaN/Infinity; the guard mirrors the TS finite check.
    Ok(to_iso_utc(ms))
}

/// Parse the fixed RFC 3339 subset into epoch milliseconds.
fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    // YYYY-MM-DDTHH:MM:SS(.frac)?(Z|±HH:MM) — 20 chars minimum.
    if b.len() < 20 {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let mut n: i64 = 0;
        for i in range {
            let d = (b[i] as char).to_digit(10)?;
            n = n * 10 + i64::from(d);
        }
        Some(n)
    };
    if b[4] != b'-'
        || b[7] != b'-'
        || (b[10] != b'T' && b[10] != b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    let hour = digits(11..13)?;
    let minute = digits(14..16)?;
    let second = digits(17..19)?;
    let mut pos = 19;
    let mut frac_ms: i64 = 0;
    if pos < b.len() && b[pos] == b'.' {
        pos += 1;
        let start = pos;
        while pos < b.len() && b[pos].is_ascii_digit() {
            pos += 1;
        }
        if pos == start {
            return None;
        }
        // Up to three digits count as milliseconds; further digits add
        // sub-millisecond precision which JS Date.parse also truncates.
        let frac = &value[start..pos];
        let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
        frac_ms = padded.parse().ok()?;
    }
    let offset_minutes: i64 = match b.get(pos) {
        Some(b'Z') | Some(b'z') => {
            if pos + 1 != b.len() {
                return None;
            }
            0
        }
        Some(sign @ (b'+' | b'-')) => {
            if pos + 6 != b.len() || b[pos + 3] != b':' {
                return None;
            }
            let oh = digits(pos + 1..pos + 3)?;
            let om = digits(pos + 4..pos + 6)?;
            let magnitude = oh * 60 + om;
            if *sign == b'+' { magnitude } else { -magnitude }
        }
        _ => return None,
    };

    if !(1..=12).contains(&month) {
        return None;
    }
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(secs * 1000 + frac_ms)
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Days from 1970-01-01 (Howard Hinnant's civil_from_days inverse).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Epoch milliseconds as the `toISOString` shape: `YYYY-MM-DDTHH:MM:SS.sssZ`.
pub fn to_iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}
