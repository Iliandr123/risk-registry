package uptime.app.risks;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.DateTimeException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import uptime.app.http.ApiProblem;
import uptime.app.risks.RiskResponses.Participant;

record RiskOccurrence(UUID id, String text, String url, Participant author, OffsetDateTime createdAt, long revision) {
    record Page(List<RiskOccurrence> items, String nextCursor) {}

    record Content(String text, String url) {
        private static final Pattern WHITESPACE = Pattern.compile("[\\s\\p{Zs}\\u2028\\u2029\\uFEFF]*");
        private static final Pattern HTTP_AUTHORITY =
                Pattern.compile("(?:[^@]*@)?(?:\\[[^\\]]+\\]|[^:/?#@\\[\\]]+)(?::[0-9]*)?");

        static Content from(JsonNode body) {
            String text = readText(body, "text");
            String url = readText(body, "url");
            if (text == null && url == null || text != null && WHITESPACE.matcher(text).matches()) {
                throw ApiProblem.invalidRequest();
            }
            if (url != null) {
                URI uri;
                try {
                    uri = URI.create(url);
                } catch (IllegalArgumentException exception) {
                    throw ApiProblem.invalidRequest();
                }
                boolean http = "http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme());
                if (!http || uri.getRawAuthority() == null || !HTTP_AUTHORITY.matcher(uri.getRawAuthority()).matches()
                        || !url.equals(uri.toASCIIString())) {
                    throw ApiProblem.invalidRequest();
                }
            }
            return new Content(text, url);
        }

        private static String readText(JsonNode body, String field) {
            JsonNode value = body.get(field);
            if (value == null || value.isNull()) {
                return null;
            }
            if (!value.isTextual() || value.asText().indexOf('\0') >= 0) {
                throw ApiProblem.invalidRequest();
            }
            return value.asText();
        }
    }

    record Cursor(UUID riskId, OffsetDateTime createdAt, UUID id) {
        String encode() {
            String value = riskId + "|" + createdAt + "|" + id;
            return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.US_ASCII));
        }

        static Cursor decode(UUID riskId, String encoded) {
            if (encoded.length() > 160) {
                throw ApiProblem.invalidRequest();
            }
            try {
                String[] fields = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.US_ASCII)
                        .split("\\|", -1);
                if (fields.length == 3 && riskId.toString().equals(fields[0])) {
                    OffsetDateTime createdAt = OffsetDateTime.parse(fields[1]);
                    var cursor = new Cursor(riskId, createdAt, UUID.fromString(fields[2]));
                    if (createdAt.getOffset().equals(ZoneOffset.UTC) && createdAt.getYear() >= 1
                            && createdAt.getYear() <= 9999 && createdAt.getNano() % 1000 == 0
                            && cursor.encode().equals(encoded)) {
                        return cursor;
                    }
                }
            } catch (IllegalArgumentException | DateTimeException exception) {
                throw ApiProblem.invalidRequest();
            }
            throw ApiProblem.invalidRequest();
        }
    }
}
