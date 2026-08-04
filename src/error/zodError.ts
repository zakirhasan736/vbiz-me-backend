import { ZodError } from 'zod'
import { IErrorSources, IGenericErrorRes } from '../interfaces/error.interface'

const handleZodError = (err: ZodError): IGenericErrorRes => {
  const errorSources: IErrorSources = err.errors.map((error) => {
    return { path: error.path.join('.'), message: error.message }
  })

  return {
    statusCode: 400,
    message: 'Validation Error',
    errorSources,
  }
}

export default handleZodError
