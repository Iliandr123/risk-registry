package uptime.app.risks;

import java.net.URI;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;
import tools.jackson.databind.JsonNode;
import uptime.app.http.ApiProblem;
import uptime.app.risks.RiskResponses.FieldChange;

record DraftFields(String title, String cause, String possibleEvent, String productConsequences,
                   Integer likelihood, Integer impact, String decisionNote,
                   String trackerUrl, RiskState riskState, String closureReason) implements RiskResponses.ProposalFields {
    private static final Set<String> NAMES = Set.of("title", "cause", "possibleEvent", "productConsequences",
            "likelihood", "impact", "decisionNote", "trackerUrl", "riskState", "closureReason", "groupId");

    private enum PublishedField {
        title(DraftFields::title), cause(DraftFields::cause), possibleEvent(DraftFields::possibleEvent),
        productConsequences(DraftFields::productConsequences), likelihood(DraftFields::likelihood),
        impact(DraftFields::impact), decisionNote(DraftFields::decisionNote), trackerUrl(DraftFields::trackerUrl);

        private final Function<DraftFields, ?> read;

        PublishedField(Function<DraftFields, ?> read) {
            this.read = read;
        }
    }

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

    DraftFields mergePublished(JsonNode fields) {
        if (fields == null || !fields.isObject()) {
            throw ApiProblem.invalidRequest();
        }
        for (String key : fields.propertyNames()) {
            try {
                PublishedField.valueOf(key);
            } catch (IllegalArgumentException exception) {
                throw ApiProblem.invalidRequest();
            }
        }
        DraftFields merged = merge(fields);
        if (!merged.complete()) {
            throw new ApiProblem(400, "INVALID_REQUEST", "Заполните обязательные поля риска.");
        }
        return merged;
    }

    DraftFields mergeCompletion(JsonNode fields) {
        if (fields == null || !fields.isObject()
                || !Set.of("riskState", "closureReason").containsAll(fields.propertyNames())) {
            throw ApiProblem.invalidRequest();
        }
        return withCompletionFields(fields);
    }

    DraftFields withCompletionFields(JsonNode input) {
        RiskState state;
        try {
            String value = text(input, "riskState", riskState.name());
            state = value == null ? RiskState.ACTIVE : RiskState.valueOf(value);
        } catch (IllegalArgumentException exception) {
            throw ApiProblem.invalidRequest();
        }
        if (state == RiskState.ACTIVE) {
            throw ApiProblem.invalidRequest();
        }
        return withCompletion(state, text(input, "closureReason", closureReason));
    }

    DraftFields withCompletion(RiskState state, String reason) {
        return new DraftFields(title, cause, possibleEvent, productConsequences, likelihood, impact,
                decisionNote, trackerUrl, state, reason);
    }

    void requireCompletion() {
        if (riskState == RiskState.ACTIVE || blank(closureReason)) {
            throw new ApiProblem(400, "INVALID_REQUEST", "Укажите состояние и причину завершения риска.");
        }
    }

    List<FieldChange> changesFrom(DraftFields previous) {
        return Arrays.stream(PublishedField.values())
                .map(field -> new FieldChange(field.name(), field.read.apply(previous), field.read.apply(this)))
                .filter(change -> !Objects.equals(change.previousValue(), change.newValue()))
                .toList();
    }

    private boolean complete() {
        return !blank(title) && !blank(cause) && !blank(possibleEvent) && !blank(productConsequences)
                && likelihood != null && impact != null;
    }

    void requireComplete() {
        if (!complete()) {
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
