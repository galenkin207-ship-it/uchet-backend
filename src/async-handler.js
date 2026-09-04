// Оборачивает async-обработчик роута так, чтобы любая ошибка (включая
// отклонённый промис — например, ошибка Postgres) уходила в next(err) и
// попадала в общий error-handler (см. app.js), а не зависала без ответа.
//
// Без этой обёртки Express 4.x не перехватывает исключения из async-функций
// сам: если внутри такого хендлера что-то бросает без try/catch, промис
// отклоняется, next() не вызывается, и клиент получает зависший запрос
// вместо кода ошибки (см. разбор в auth.js/requests.js/users.js и т.д.).
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
