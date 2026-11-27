package uptime.app.risks;

import java.net.URI;
import java.util.Set;
import tools.jackson.databind.JsonNode;
import uptime.app.http.ApiProblem;

record DraftFields(String title, String cause, String possibleEvent, String productConsequences,
                   Integer likelihood, Integer impact, String decisionNote,
                   String trackerUrl, RiskState riskState, String closureReason) {
    private static final Set<String> NAMES = Set.of("title", "cause", "possibleEvent", "productConsequences",
            "likelihood", "impact", "decisionNote", "trackerUrl", "riskState", "closureReason");

    enum RiskState { ACTIVE, REMOVED, MATERIALIZED }

    static DraftFields initial() {
        return new DraftFields(null, null, null, null, null, null, null, null, RiskState.ACTIVE, null);
    }

    DraftFields merge(JsonNode fields) {
        if (fields == null || !fields.isObject()) {
            throw ApiProblem.invalidRequest();
        }
        for (var name : fields.propertyNames()) {
            if (!NAMES.contains(name)) {
                throw ApiProblem.invalidRequest();
            }
        }
        try {
            String url = text(fields, "trackerUrl", trackerUrl);
            if (url != null && !URI.create(url).isAbsolute()) {
                throw ApiProblem.invalidRequest();
            }
            String state = text(fields, "riskState", riskState.name());
            if (state == null) {
                throw ApiProblem.invalidRequest();
            }
            return new DraftFields(text(fields, "title", title), text(fields, "cause", cause),
                    text(fields, "possibleEvent", possibleEvent), text(fields, "productConsequences", productConsequences),
                    score(fields, "likelihood", likelihood), score(fields, "impact", impact),
                    text(fields, "decisionNote", decisionNote), url, RiskState.valueOf(state),
                    text(fields, "closureReason", closureReason));
        } catch (IllegalArgumentException exception) {
            throw ApiProblem.invalidRequest();
        }
    }

    void requireComplete() {
        if (blank(title) || blank(cause) || blank(possibleEvent) || blank(productConsequences)
                || likelihood == null || impact == null) {
            throw new ApiProblem(400, "INVALID_REQUEST", "Заполните обязательные поля предложения.");
        }
    }

    static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    private static String text(JsonNode fields, String name, String previous) {
        JsonNode value = fields.get(name);
        if (value == null) {
            return previous;
        }
        if (value.isNull()) {
            return null;
        }
        if (!value.isTextual() || value.asText().indexOf('\0') >= 0) {
            throw ApiProblem.invalidRequest();
        }
        return value.asText();
    }

    private static Integer score(JsonNode fields, String name, Integer previous) {
        JsonNode value = fields.get(name);
        if (value == null) {
            return previous;
        }
        if (value.isNull()) {
            return null;
        }
        if (!value.isIntegralNumber() || !value.canConvertToInt() || value.asInt() < 1 || value.asInt() > 10) {
            throw ApiProblem.invalidRequest();
        }
        return value.asInt();
    }
}
