import { isMilestone, toIso } from './model.js';

function xml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

export function taskName(t, lang) {
  return lang === 'en' && t.nameEn ? t.nameEn : t.name;
}

export function phaseName(p, lang) {
  return lang === 'en' && p.nameEn ? p.nameEn : p.name;
}

const stamp = (day, time) => `${toIso(day)}T${time}`;

// Microsoft Project XML (MSPDI), which MS Project and ProjectLibre both import.
// Each task carries its computed dates as a start-no-earlier-than constraint on a
// seven-day calendar, so the file opens with the same dates the page shows.
export function toMspdi(doc, sched, lang = 'he') {
  const weekDays = [1, 2, 3, 4, 5, 6, 7].map((d) => `<WeekDay><DayType>${d}</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime><WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>`).join('');

  const uid = new Map();
  let next = 1;
  const lines = [];
  let id = 1;
  const plan = [];
  doc.phases.forEach((phase, pi) => {
    const kids = doc.tasks.filter((t) => t.phase === phase.id && sched.rows.has(t.id));
    if (!kids.length) return;
    plan.push({ phase, pi, uid: next++, id: id++, kids });
    kids.forEach((t) => { uid.set(t.id, { uid: next++, id: id++ }); });
  });
  for (const { phase, pi, uid: phaseUid, id: phaseId, kids } of plan) {
    const rows = kids.map((t) => sched.rows.get(t.id));
    const start = Math.min(...rows.map((r) => r.start));
    const end = Math.max(...rows.map((r) => r.end));
    lines.push(`<Task><UID>${phaseUid}</UID><ID>${phaseId}</ID><Name>${xml(phaseName(phase, lang))}</Name><OutlineNumber>${pi + 1}</OutlineNumber><OutlineLevel>1</OutlineLevel><Start>${stamp(start, '08:00:00')}</Start><Finish>${stamp(end, '17:00:00')}</Finish><Duration>PT${(end - start + 1) * 8}H0M0S</Duration><DurationFormat>7</DurationFormat><Milestone>0</Milestone><Summary>1</Summary></Task>`);
    kids.forEach((t, ti) => {
      const r = sched.rows.get(t.id);
      const milestone = isMilestone(t);
      const hours = milestone ? 0 : (r.end - r.start + 1) * 8;
      const links = (t.deps || [])
        .filter((d) => uid.get(d.id))
        .map((d) => `<PredecessorLink><PredecessorUID>${uid.get(d.id).uid}</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`)
        .join('');
      const pct = t.status === 'done' ? 100 : Math.round(t.progress || 0);
      const me = uid.get(t.id);
      lines.push(`<Task><UID>${me.uid}</UID><ID>${me.id}</ID><Name>${xml(taskName(t, lang))}</Name><OutlineNumber>${pi + 1}.${ti + 1}</OutlineNumber><OutlineLevel>2</OutlineLevel><Start>${stamp(r.start, '08:00:00')}</Start><Finish>${stamp(r.end, milestone ? '08:00:00' : '17:00:00')}</Finish><Duration>PT${hours}H0M0S</Duration><DurationFormat>7</DurationFormat><Milestone>${milestone ? 1 : 0}</Milestone><Summary>0</Summary><PercentComplete>${pct}</PercentComplete><ConstraintType>4</ConstraintType><ConstraintDate>${stamp(r.start, '08:00:00')}</ConstraintDate>${t.note ? `<Notes>${xml(t.note)}</Notes>` : ''}${links}</Task>`);
    });
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project"><Name>${xml(doc.title)}</Name><Title>${xml(doc.title)}</Title><ScheduleFromStart>1</ScheduleFromStart><StartDate>${stamp(sched.projectStart, '08:00:00')}</StartDate><FinishDate>${stamp(sched.projectEnd, '17:00:00')}</FinishDate><CalendarUID>1</CalendarUID><DefaultStartTime>08:00:00</DefaultStartTime><DefaultFinishTime>17:00:00</DefaultFinishTime><MinutesPerDay>480</MinutesPerDay><MinutesPerWeek>3360</MinutesPerWeek><DaysPerMonth>30</DaysPerMonth><Calendars><Calendar><UID>1</UID><Name>Project 7-day</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays>${weekDays}</WeekDays></Calendar></Calendars><Tasks>
${lines.join('\n')}
</Tasks></Project>
`;
}
