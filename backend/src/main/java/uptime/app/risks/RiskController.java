package uptime.app.risks;

import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import uptime.app.accounts.AccountDirectory.Member;
import uptime.app.http.ApiProblem;
import uptime.app.risks.RiskOccurrence.Content;
import uptime.app.risks.RiskResponses.Category;
import uptime.app.risks.RiskResponses.History;
import uptime.app.risks.RiskResponses.Identity;
import uptime.app.risks.RiskResponses.Listing;
import uptime.app.risks.RiskResponses.Proposal;
import uptime.app.risks.RiskResponses.Published;
import uptime.app.risks.RiskStore.EventAction;

@RestController
@RequestMapping("/api/risks")
class RiskController {
    private static final String MEMBER = RiskAccess.MEMBER_ATTRIBUTE;
    private final RiskService risks;

    RiskController(RiskService risks) {
        this.risks = risks;
    }

    @GetMapping
    Listing<?> list(@RequestAttribute(MEMBER) Member member,
                    @RequestParam(name = "view", required = false) String view,
                    @RequestParam(name = "q", required = false) String query,
                    @RequestParam(name = "assignee", required = false) String assignee,
                    @RequestParam(name = "category", required = false) String category) {
        try {
            boolean needsAssignment = "needs-assignment".equals(assignee);
            String selectedView = view == null ? "active" : view;
            if (needsAssignment && !selectedView.equals("active")) {
                throw ApiProblem.invalidRequest();
            }
            return risks.list(member, selectedView, query, assignee == null || needsAssignment ? null : uuid(assignee),
                    needsAssignment, category == null ? null : Category.valueOf(category));
        } catch (IllegalArgumentException exception) {
            throw ApiProblem.invalidRequest();
        }
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    Proposal create(@RequestAttribute(MEMBER) Member member, @RequestBody JsonNode body) {
        return risks.create(member, body);
    }

    @GetMapping("/{id}")
    Published get(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id) {
        return risks.published(member, pathId(id));
    }

    @GetMapping("/{id}/occurrences")
    RiskOccurrence.Page occurrences(@PathVariable("id") String id,
                                    @RequestParam(name = "cursor", required = false) String cursor) {
        return risks.occurrences(pathId(id), cursor);
    }

    @PostMapping("/{id}/occurrences")
    @ResponseStatus(HttpStatus.CREATED)
    RiskOccurrence createOccurrence(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id,
                                    @RequestBody JsonNode body) {
        requireObject(body, Set.of("text", "url"));
        return risks.createOccurrence(member, pathId(id), Content.from(body));
    }

    @PatchMapping("/{id}/occurrences/{occurrenceId}")
    RiskOccurrence updateOccurrence(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id,
                                    @PathVariable("occurrenceId") String occurrenceId, @RequestBody JsonNode body) {
        requireObject(body, Set.of("text", "url", "expectedRevision"));
        return risks.updateOccurrence(member, pathId(id), pathId(occurrenceId),
                revision(body, "expectedRevision"), Content.from(body));
    }

    @DeleteMapping("/{id}/occurrences/{occurrenceId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void deleteOccurrence(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id,
                          @PathVariable("occurrenceId") String occurrenceId,
                          @RequestParam(name = "expectedRevision", required = false) String expectedRevision) {
        long revision;
        try {
            revision = Long.parseLong(expectedRevision);
        } catch (NumberFormatException exception) {
            throw ApiProblem.invalidRequest();
        }
        if (revision < 1) {
            throw ApiProblem.invalidRequest();
        }
        risks.deleteOccurrence(member, pathId(id), pathId(occurrenceId), revision);
    }

    @PatchMapping("/{id}/assignment")
    Published assign(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id,
                     @RequestBody JsonNode body) {
        requireObject(body, Set.of("assigneeId", "expectedAssignmentRevision"));
        JsonNode candidate = body.get("assigneeId");
        UUID assigneeId = candidate != null && candidate.isNull() ? null : requestId(body, "assigneeId");
        return risks.assign(member, pathId(id), assigneeId, revision(body, "expectedAssignmentRevision"));
    }

    @GetMapping("/{id}/history")
    History history(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id) {
        return risks.history(member, pathId(id));
    }

    @GetMapping("/{id}/draft")
    Proposal draft(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id) {
        return risks.draft(member, pathId(id));
    }

    @PostMapping("/{id}/draft")
    @ResponseStatus(HttpStatus.CREATED)
    Proposal open(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id,
                  @RequestBody JsonNode body) {
        return risks.open(member, pathId(id), expectedSnapshot(body));
    }

    @PatchMapping("/{id}/draft")
    Proposal save(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id,
                  @RequestBody JsonNode body) {
        requireObject(body, Set.of("versionId", "expectedRevision", "fields"));
        return risks.save(member, pathId(id), requestId(body, "versionId"),
                revision(body, "expectedRevision"), body.get("fields"));
    }

    @PostMapping("/{id}/draft/{action}")
    Identity act(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id,
                 @PathVariable("action") String action, @RequestBody JsonNode body) {
        EventAction event = switch (action) {
            case "submit" -> EventAction.SUBMIT;
            case "return" -> EventAction.RETURN;
            case "approve" -> EventAction.APPROVE;
            case "withdraw" -> EventAction.WITHDRAW;
            case "unblock" -> EventAction.UNBLOCK;
            default -> throw ApiProblem.notFound();
        };
        requireObject(body, Set.of("versionId", "expectedRevision", "comment"));
        JsonNode comment = body.get("comment");
        if (comment != null && (!comment.isTextual() || comment.asText().isBlank()
                || comment.asText().indexOf('\0') >= 0)) {
            throw ApiProblem.invalidRequest();
        }
        return risks.act(member, pathId(id), requestId(body, "versionId"), revision(body, "expectedRevision"), event,
                comment == null ? null : comment.asText());
    }

    @PostMapping("/{id}/assessment/confirm")
    Published confirm(@RequestAttribute(MEMBER) Member member, @PathVariable("id") String id,
                      @RequestBody JsonNode body) {
        return risks.confirm(member, pathId(id), expectedSnapshot(body));
    }

    private static UUID expectedSnapshot(JsonNode body) {
        requireObject(body, Set.of("expectedPublishedVersionId"));
        return requestId(body, "expectedPublishedVersionId");
    }

    private static void requireObject(JsonNode body, Set<String> allowed) {
        if (!body.isObject() || !allowed.containsAll(body.propertyNames())) {
            throw ApiProblem.invalidRequest();
        }
    }

    private static long revision(JsonNode body, String field) {
        JsonNode revision = body.get(field);
        if (revision == null || !revision.isIntegralNumber() || !revision.canConvertToLong()
                || revision.asLong() < 1) {
            throw ApiProblem.invalidRequest();
        }
        return revision.asLong();
    }

    private static UUID requestId(JsonNode body, String field) {
        JsonNode value = body.get(field);
        if (value == null || !value.isTextual()) {
            throw ApiProblem.invalidRequest();
        }
        try {
            return uuid(value.asText());
        } catch (IllegalArgumentException exception) {
            throw ApiProblem.invalidRequest();
        }
    }

    private static UUID pathId(String id) {
        try {
            return uuid(id);
        } catch (IllegalArgumentException exception) {
            throw ApiProblem.notFound();
        }
    }

    private static UUID uuid(String text) {
        UUID id = UUID.fromString(text);
        if (!id.toString().equalsIgnoreCase(text)) {
            throw new IllegalArgumentException("Invalid UUID");
        }
        return id;
    }
}
