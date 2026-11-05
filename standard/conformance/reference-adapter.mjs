// The reference implementation as a conformance adapter:
//   node conformance/run.mjs conformance/reference-adapter.mjs   (after installing dependencies)
import { SUBJECT_KINDS, decisionSchema, doorString, parseDoor, subjectSchema, taskSchema } from '@starlings/subject-spec';

export default {
  subjectKinds: SUBJECT_KINDS,
  parseDoor,
  doorString,
  validateDecision: (record) => decisionSchema.safeParse(record).success,
  validateSubject: (record) => subjectSchema.safeParse(record).success,
  validateTask: (record) => taskSchema.safeParse(record).success,
};
