/**
 * Holiday API Client
 * Integrates with https://libur.deno.dev/ API for Indonesian national holidays
 */

const https = require('https');

const API_BASE_URL = 'https://libur.deno.dev/api';

/**
 * Make HTTPS request to holiday API
 * @param {string} path - API endpoint path
 * @returns {Promise<any>} Parsed JSON response
 */
function request(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE_URL}${path}`;
    
    https.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    }).on('error', (err) => {
      reject(new Error(`Request failed: ${err.message}`));
    });
  });
}

/**
 * Get all holidays for a specific year
 * @param {number} [year] - Year (default: current year)
 * @returns {Promise<Array<{date: string, name: string}>>}
 */
async function getHolidaysForYear(year) {
  const currentYear = new Date().getFullYear();
  const targetYear = year || currentYear;
  
  try {
    const holidays = await request(`?year=${targetYear}`);
    console.log(`[Holiday API] Fetched ${holidays.length} holidays for year ${targetYear}`);
    return holidays;
  } catch (err) {
    console.error(`[Holiday API] Failed to fetch holidays:`, err.message);
    return [];
  }
}

/**
 * Check if a specific date is a holiday
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {Promise<{isHoliday: boolean, name: string|null}>}
 */
async function checkDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  
  try {
    const result = await request(`?year=${year}&month=${month}&day=${day}`);
    return {
      isHoliday: result.is_holiday,
      name: result.holiday_list && result.holiday_list.length > 0 
        ? result.holiday_list.join(', ') 
        : null,
    };
  } catch (err) {
    console.error(`[Holiday API] Failed to check date ${dateStr}:`, err.message);
    return { isHoliday: false, name: null };
  }
}

/**
 * Check if today is a holiday
 * @returns {Promise<{isHoliday: boolean, name: string|null}>}
 */
async function checkToday() {
  try {
    const result = await request('/today');
    return {
      isHoliday: result.is_holiday,
      name: result.holiday_list && result.holiday_list.length > 0 
        ? result.holiday_list.join(', ') 
        : null,
    };
  } catch (err) {
    console.error('[Holiday API] Failed to check today:', err.message);
    return { isHoliday: false, name: null };
  }
}

/**
 * Sync holidays for current and next year to database
 * @param {object} db - Database module
 * @returns {Promise<number>} Number of holidays synced
 */
async function syncHolidaysToDb(db) {
  const currentYear = new Date().getFullYear();
  const nextYear = currentYear + 1;
  
  try {
    console.log(`[Holiday API] Syncing holidays for ${currentYear} and ${nextYear}...`);
    
    const currentYearHolidays = await getHolidaysForYear(currentYear);
    const nextYearHolidays = await getHolidaysForYear(nextYear);
    
    const allHolidays = [...currentYearHolidays, ...nextYearHolidays];
    
    if (allHolidays.length > 0) {
      db.syncNationalHolidays(allHolidays);
      console.log(`[Holiday API] Synced ${allHolidays.length} national holidays to database`);
    }
    
    return allHolidays.length;
  } catch (err) {
    console.error('[Holiday API] Sync failed:', err.message);
    return 0;
  }
}

module.exports = {
  getHolidaysForYear,
  checkDate,
  checkToday,
  syncHolidaysToDb,
};
