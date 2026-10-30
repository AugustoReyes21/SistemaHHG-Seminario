/**
 * Error de negocio con estado HTTP propio.
 * Se lanza dentro de una transacción para que haga ROLLBACK y el
 * manejador global responda con el código correcto (409, 422...) en vez de 500.
 */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code) this.code = code;
  }
}

const conflict = (message, code = 'CONFLICT') => new HttpError(409, message, code);
const unprocessable = (message, code = 'UNPROCESSABLE') => new HttpError(422, message, code);

module.exports = { HttpError, conflict, unprocessable };
