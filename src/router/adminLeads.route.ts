import { Router } from 'express'
import adminLeadsController from '../controller/adminLeads.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import AdminLeadsZodSchema from '../zodValidation/adminLeads.zod'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/leads/stats', adminLeadsController.stats)
router.get('/leads/saves', adminLeadsController.listSaves)
router.patch('/leads/saves/:id', validSchema(AdminLeadsZodSchema.patchLeadBody), adminLeadsController.patchSave)
router.delete('/leads/saves/:id', adminLeadsController.deleteSave)
router.get('/leads/notes', adminLeadsController.listNotes)
router.patch('/leads/notes/:id', validSchema(AdminLeadsZodSchema.patchLeadBody), adminLeadsController.patchNote)
router.delete('/leads/notes/:id', adminLeadsController.deleteNote)

export default router
