/**
 * CEOVA CCTV // Context Engine
 * context/schedules/schedule_manager.js
 * 
 * Operating Hours & Employee Shift Schedule Evaluator.
 * Checks whether observations occur within operating hours or active staff shifts.
 */

class ScheduleManager {
  constructor() {
    this.schedules = new Map();
    this._initializeDefaultSchedules();
  }

  _initializeDefaultSchedules() {
    // Default standard operating shift: Monday-Saturday, 08:00 to 20:00
    this.addSchedule({
      id: 'SCH-DEFAULT',
      name: 'Standard Day Shift',
      days: [1, 2, 3, 4, 5, 6], // Mon-Sat
      startHour: 8,
      endHour: 20
    });

    // Security Night Shift: All days, 19:00 to 07:00
    this.addSchedule({
      id: 'SCH-SECURITY',
      name: 'Security 24/7 Shift',
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24
    });
  }

  addSchedule(sch) {
    this.schedules.set(sch.id, sch);
  }

  /**
   * Check if a timestamp falls within a specific schedule
   * @param {string} scheduleId 
   * @param {Date|number} timestamp 
   * @returns {number} Score: 1.0 (on-schedule), 0.35 (outside working hours)
   */
  evaluateScheduleScore(scheduleId = 'SCH-DEFAULT', timestamp = Date.now()) {
    const sch = this.schedules.get(scheduleId) || this.schedules.get('SCH-DEFAULT');
    if (!sch) return 0.5;

    const date = new Date(timestamp);
    const day = date.getDay();
    const hour = date.getHours() + (date.getMinutes() / 60);

    const isDayActive = sch.days.includes(day);
    let isTimeActive = false;

    if (sch.startHour <= sch.endHour) {
      isTimeActive = hour >= sch.startHour && hour <= sch.endHour;
    } else {
      // Overnight shift
      isTimeActive = hour >= sch.startHour || hour <= sch.endHour;
    }

    if (isDayActive && isTimeActive) {
      return 1.0;
    }

    // Slightly outside working hours (e.g. 1 hour leeway)
    return 0.35;
  }
}

module.exports = {
  ScheduleManager
};
