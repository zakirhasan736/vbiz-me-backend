import { Router } from 'express'
import crmController from '../controller/crm.controller'
import crmEventController from '../controller/crmEvent.controller'
import leadNoteController from '../controller/leadNote.controller'
import workNoteController from '../controller/workNote.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import CrmZodSchema from '../zodValidation/crm.zod'
import CrmEventZodSchema from '../zodValidation/crmEvent.zod'
import LeadNoteZodSchema from '../zodValidation/leadNote.zod'
import WorkNoteZodSchema from '../zodValidation/workNote.zod'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)

router.get('/dashboard', crmController.dashboard)
router.get('/leads', crmController.listLeads)
router.post('/leads', validSchema(CrmZodSchema.createLeadBody), crmController.createLead)
router.get('/leads/:leadId/notes', leadNoteController.list)
router.post('/leads/:leadId/notes', validSchema(LeadNoteZodSchema.createBody), leadNoteController.create)
router.patch('/leads/:leadId/notes/:noteId', validSchema(LeadNoteZodSchema.updateBody), leadNoteController.update)
router.delete('/leads/:leadId/notes/:noteId', leadNoteController.remove)
router.patch('/leads/:id', validSchema(CrmZodSchema.patchLeadBody), crmController.patchLead)
router.delete('/leads/:id', crmController.deleteLead)
router.get('/schedule-people', crmController.searchSchedulePeople)
router.get('/schedule-calendar', crmController.scheduleCalendar)

router.get('/events', crmEventController.list)
router.get('/events/:id', crmEventController.getOne)
router.post('/events', validSchema(CrmEventZodSchema.createCrmEvent), crmEventController.create)
router.patch('/events/:id', validSchema(CrmEventZodSchema.updateCrmEvent), crmEventController.update)
router.delete('/events/:id', crmEventController.remove)

router.get('/work-notes', workNoteController.list)
router.patch('/work-notes/reorder', validSchema(WorkNoteZodSchema.reorderBody), workNoteController.reorder)
router.get('/work-notes/:id', workNoteController.getOne)
router.post('/work-notes', validSchema(WorkNoteZodSchema.createBody), workNoteController.create)
router.patch('/work-notes/:id', validSchema(WorkNoteZodSchema.updateBody), workNoteController.update)
router.delete('/work-notes/:id', workNoteController.remove)

export default router
