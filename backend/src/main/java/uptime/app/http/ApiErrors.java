package uptime.app.http;

import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
class ApiErrors {
    @ExceptionHandler(ApiProblem.class)
    ResponseEntity<ErrorBody> problem(ApiProblem problem) {
        var response = ResponseEntity.status(problem.status());
        if (problem.retryAfter() > 0) {
            response.header(HttpHeaders.RETRY_AFTER, Long.toString(problem.retryAfter()));
        }
        return response.body(new ErrorBody(problem.code(), problem.getMessage()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<ErrorBody> invalidBody() {
        return problem(ApiProblem.invalidRequest());
    }

    @ExceptionHandler(NoResourceFoundException.class)
    ResponseEntity<ErrorBody> missingResource() {
        return problem(ApiProblem.notFound());
    }

    private record ErrorBody(String code, String message) {}
}
