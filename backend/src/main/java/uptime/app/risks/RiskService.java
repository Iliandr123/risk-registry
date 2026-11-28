package uptime.app.risks;

import java.text.Collator;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import uptime.app.accounts.AccountDirectory;
import uptime.app.accounts.AccountDirectory.Member;
import uptime.app.http.ApiProblem;
import uptime.app.risks.DraftFields.RiskState;
import uptime.app.risks.RiskOccurrence.Content;
import uptime.app.risks.RiskOccurrence.Cursor;
import uptime.app.risks.RiskResponses.Assessment;
import uptime.app.risks.RiskResponses.AssessmentConfirmedEvent;
import uptime.app.risks.RiskResponses.AssignmentEvent;
import uptime.app.risks.RiskResponses.Category;
import uptime.app.risks.RiskResponses.Event;
import uptime.app.risks.RiskResponses.FieldChange;
import uptime.app.risks.RiskResponses.FieldsUpdatedEvent;
import uptime.app.risks.RiskResponses.FirstProposalFields;
import uptime.app.risks.RiskResponses.FirstPublicationEvent;
import uptime.app.risks.RiskResponses.GroupEvent;
import uptime.app.risks.RiskResponses.HistoricalSnapshot;
import uptime.app.risks.RiskResponses.History;
import uptime.app.risks.RiskResponses.Identity;
import uptime.app.risks.RiskResponses.Listing;
import uptime.app.risks.RiskResponses.Participant;
import uptime.app.risks.RiskResponses.Priority;
import uptime.app.risks.RiskResponses.Proposal;
import uptime.app.risks.RiskResponses.ProposalKind;
import uptime.app.risks.RiskResponses.Published;
import uptime.app.risks.RiskResponses.Snapshot;
import uptime.app.risks.RiskResponses.Summary;
import uptime.app.risks.RiskResponses.Unblock;
import uptime.app.risks.RiskResponses.WorkflowEvent;
import uptime.app.risks.RiskStore.EventAction;
import uptime.app.risks.RiskStore.Risk;
import uptime.app.risks.RiskVersion.Status;

@Service
@Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
class RiskService {
    private static final int OCCURRENCE_PAGE_SIZE = 20;
    private final RiskStore store;
    private final RiskOccurrenceStore occurrenceStore;
    private final RiskGroupStore groups;
    private final AccountDirectory accounts;
    private final RiskCalendar calendar;

    record ManualReviewDateEdit(LocalDate expected, LocalDate value) {}

    RiskService(RiskStore store, RiskOccurrenceStore occurrenceStore, RiskGroupStore groups, AccountDirectory accounts,
                RiskCalendar calendar) {
        this.store = store;
        this.occurrenceStore = occurrenceStore;
        this.groups = groups;
        this.accounts = accounts;
        this.calendar = calendar;
    }

    Listing<?> list(Member member, String view, String query, UUID assigneeId, boolean needsAssignment,
                    Category category, UUID groupId, boolean ungrouped) {
        return switch (view) {
            case "active", "archive" -> new Listing<>(view,
                    summaries(view.equals("archive"), query, assigneeId, needsAssignment, category, groupId, ungrouped));
            case "mine" -> new Listing<>(view, proposals(member.id()));
            case "review" -> {
                requireReviewer(member);
                yield new Listing<>(view, proposals(null));
            }
            default -> throw ApiProblem.invalidRequest();
        };
    }

    Published published(Member member, UUID id) {
        return published(member, risk(id, false));
    }

    @Transactional
    Published updatePublished(Member member, UUID id, UUID expectedSnapshot, JsonNode input,
                              ManualReviewDateEdit reviewDate) {
        Risk risk = risk(id, true);
        requirePublished(risk);
        if (!member.reviewer() && !member.admin() && !member.id().equals(risk.assigneeId())) {
            throw ApiProblem.forbidden();
        }
        DraftFields previous = requireActiveSnapshot(risk, expectedSnapshot).fields();
        LocalDate previousDate = risk.manualReviewDate();
        if (reviewDate != null) {
            requireTransition(Objects.equals(previousDate, reviewDate.expected()));
        }
        LocalDate manualDate = reviewDate == null ? previousDate : reviewDate.value();
        boolean dateChanged = !Objects.equals(previousDate, manualDate);
        var now = calendar.now();
        LocalDate today = now.toLocalDate();
        if (dateChanged && manualDate != null && manualDate.isBefore(today)) {
            throw ApiProblem.invalidRequest();
        }
        DraftFields fields = previous.mergePublished(input);
        if (fields.equals(previous) && !dateChanged) {
            return published(member, risk);
        }
        UUID updatedId = store.insertPublishedEdit(risk, member.id(), fields, manualDate, now);
        store.publish(id, updatedId, Assessment.dateAfterEdit(risk.assessmentDate(), today, previous, fields), manualDate);
        return published(member, risk(id, false));
    }

    RiskOccurrence.Page occurrences(UUID id, String encodedCursor) {
        requirePublished(risk(id, false));
        Cursor cursor = encodedCursor == null ? null : Cursor.decode(id, encodedCursor);
        var items = occurrenceStore.page(id, cursor, OCCURRENCE_PAGE_SIZE + 1);
        if (items.size() <= OCCURRENCE_PAGE_SIZE) {
            return new RiskOccurrence.Page(items, null);
        }
        var page = items.subList(0, OCCURRENCE_PAGE_SIZE);
        var last = page.getLast();
        return new RiskOccurrence.Page(page, new Cursor(id, last.createdAt(), last.id()).encode());
    }

    @Transactional
    RiskOccurrence createOccurrence(Member member, UUID id, Content content) {
        Risk risk = risk(id, true);
        requireActiveSnapshot(risk, risk.publishedVersionId());
        return occurrenceStore.insert(id, member.id(), content);
    }

    @Transactional
    RiskOccurrence updateOccurrence(Member member, UUID id, UUID occurrenceId, long revision, Content content) {
        requireOccurrenceChange(member, id, occurrenceId, revision);
        return occurrenceStore.update(id, occurrenceId, content);
    }

    @Transactional
    void deleteOccurrence(Member member, UUID id, UUID occurrenceId, long revision) {
        requireOccurrenceChange(member, id, occurrenceId, revision);
        occurrenceStore.delete(id, occurrenceId);
    }

    private void requireOccurrenceChange(Member member, UUID id, UUID occurrenceId, long revision) {
        Risk risk = risk(id, true);
        requirePublished(risk);
        RiskOccurrence occurrence = occurrenceStore.find(id, occurrenceId).orElseThrow(ApiProblem::notFound);
        if (!occurrence.author().id().equals(member.id()) && !member.reviewer() && !member.admin()) {
            throw ApiProblem.forbidden();
        }
        requireActiveSnapshot(risk, risk.publishedVersionId());
        requireTransition(occurrence.revision() == revision);
    }

    Proposal draft(Member member, UUID id) {
        RiskVersion draft = store.draft(id).filter(version -> version.visibleTo(member))
                .orElseThrow(ApiProblem::notFound);
        return proposal(draft, risk(id, false));
    }

    History history(Member member, UUID id) {
        Risk risk = risk(id, false);
        var versions = store.versions(id).stream().collect(Collectors.toMap(RiskVersion::id, Function.identity()));
        if (!risk.published() && versions.values().stream().noneMatch(version -> version.visibleTo(member))) {
            throw ApiProblem.notFound();
        }
        var events = store.events(id);
        var snapshots = events.stream()
                .filter(event -> event.action() == EventAction.APPROVE || event.action() == EventAction.FIELDS_UPDATED)
                .map(event -> versions.get(event.versionId()))
                .map(version -> new HistoricalSnapshot(snapshot(version), account(version.historicalOwnerId())))
                .toList();
        var visibleEvents = events.stream()
                .filter(event -> event.action() == EventAction.APPROVE || event.action() == EventAction.CONFIRM_ASSESSMENT
                        || event.action().isAssignment() || event.action() == EventAction.GROUP_CHANGED
                        || event.action() == EventAction.FIELDS_UPDATED
                        || versions.get(event.versionId()).visibleTo(member))
                .toList();
        var closedProposals = visibleEvents.stream()
                .filter(event -> event.action() == EventAction.EDIT_CLOSED_BY_MIGRATION)
                .map(event -> proposal(versions.get(event.versionId()), risk))
                .toList();
        return new History(id, snapshots, visibleEvents.stream().map(event -> historyEvent(event, versions)).toList(),
                closedProposals);
    }

    @Transactional
    Proposal create(Member member, JsonNode input) {
        DraftFields fields = DraftFields.initial().merge(input);
        UUID groupId = proposalGroup(input, null);
        var risk = new Risk(UUID.randomUUID(), null, null, null, null, 1, null, 1);
        store.insertRisk(risk.id());
        return proposal(store.insertDraft(risk.id(), member.id(), fields, groupId), risk);
    }

    @Transactional
    Proposal open(Member member, UUID id, UUID expectedSnapshot, DraftFields completion) {
        Risk risk = risk(id, true);
        RiskVersion current = requireActiveSnapshot(risk, expectedSnapshot);
        if (store.draft(id).isPresent()) {
            throw conflict();
        }
        DraftFields fields = current.fields().withCompletion(completion.riskState(), completion.closureReason());
        return proposal(store.insertDraft(id, member.id(), fields, null), risk);
    }

    @Transactional
    Proposal save(Member member, UUID id, UUID versionId, long revision, JsonNode input) {
        Risk risk = risk(id, true);
        RiskVersion version = version(risk, versionId);
        requireAuthor(version, member);
        checkRevision(version, revision);
        if (!version.editable()) {
            throw conflict();
        }
        DraftFields fields = risk.published() ? version.fields().mergeCompletion(input) : version.fields().merge(input);
        UUID groupId = risk.published() ? version.proposedGroupId() : proposalGroup(input, version.proposedGroupId());
        boolean unchanged = fields.equals(version.fields()) && Objects.equals(groupId, version.proposedGroupId());
        return proposal(unchanged ? version : store.save(version, fields, groupId), risk);
    }

    private UUID proposalGroup(JsonNode input, UUID previous) {
        if (!input.has("groupId")) {
            return previous;
        }
        UUID groupId = RiskController.nullableRequestId(input, "groupId");
        if (groupId != null && groups.find(groupId).isEmpty()) {
            throw ApiProblem.invalidRequest();
        }
        return groupId;
    }
    @Transactional
    Identity act(Member member, UUID id, UUID versionId, long revision, EventAction action, String comment) {
        boolean byAuthor = action == EventAction.SUBMIT || action == EventAction.WITHDRAW;
        if (!byAuthor) {
            requireReviewer(member);
        }
        // Every mutation locks the risk before reading its current version or checking a revision.
        Risk risk = risk(id, true);
        RiskVersion version = version(risk, versionId);
        if (byAuthor) {
            requireAuthor(version, member);
        } else if (!version.visibleTo(member) && !(action == EventAction.UNBLOCK && risk.published())) {
            throw ApiProblem.notFound();
        }
        if (action == EventAction.UNBLOCK) {
            if (!risk.published() && !version.submitted()) {
                throw ApiProblem.notFound();
            }
            if (risk.published() && version.open() && version.ownedBy(member)) {
                throw ApiProblem.forbidden();
            }
        }
        checkRevision(version, revision);
        var now = calendar.now();
        Status target = switch (action) {
            case SUBMIT -> {
                requireTransition(version.editable());
                if (risk.published() || version.fields().riskState() != RiskState.ACTIVE) {
                    version.fields().requireCompletion();
                }
                if (!risk.published()) {
                    version.fields().requireComplete();
                }
                yield Status.IN_REVIEW;
            }
            case RETURN -> {
                requireTransition(version.status() == Status.IN_REVIEW);
                requireComment(comment);
                yield Status.RETURNED;
            }
            case APPROVE -> {
                requireTransition(version.status() == Status.IN_REVIEW);
                yield Status.APPROVED;
            }
            case WITHDRAW -> {
                requireTransition(version.open());
                yield Status.WITHDRAWN;
            }
            case UNBLOCK -> {
                requireTransition(version.open());
                requireComment(comment);
                yield Status.CLOSED;
            }
            case CONFIRM_ASSESSMENT, ASSIGNMENT_CHANGED, ASSIGNMENT_MIGRATED, GROUP_CHANGED, FIELDS_UPDATED,
                    EDIT_CLOSED_BY_MIGRATION ->
                    throw new IllegalArgumentException("Expected a proposal action");
        };
        DraftFields fields = version.fields();
        if (target == Status.APPROVED) {
            if (risk.published() || fields.riskState() != RiskState.ACTIVE) {
                fields.requireCompletion();
            }
            if (risk.published()) {
                DraftFields latest = requireActiveSnapshot(risk, risk.publishedVersionId()).fields();
                fields = latest.withCompletion(fields.riskState(), fields.closureReason());
            }
        }
        RiskVersion updated = store.transition(version, target, fields);
        if (target == Status.APPROVED) {
            if (!risk.published()) {
                UUID groupId = version.proposedGroupId();
                String groupName = groupId == null ? null : groups.lockForHistory(groupId).get(groupId).name();
                store.publishFirst(version, member.id(), now, comment, groupName);
                return new Identity(updated);
            }
            store.publish(id, updated.id(), risk.assessmentDate(), risk.manualReviewDate());
        }
        store.append(id, versionId, member.id(), action, now, comment);
        return new Identity(updated);
    }

    @Transactional
    Published confirm(Member member, UUID id, UUID expectedSnapshot) {
        requireReviewer(member);
        Risk risk = risk(id, true);
        requireActiveSnapshot(risk, expectedSnapshot);
        store.confirmAssessment(risk, member.id(), calendar.now());
        return published(member, risk(id, false));
    }

    @Transactional
    Published assign(Member member, UUID id, UUID assigneeId, long revision) {
        Risk risk = risk(id, true);
        if (!risk.published()) {
            throw ApiProblem.notFound();
        }
        if (!member.reviewer() && !member.admin()) {
            throw ApiProblem.forbidden();
        }
        requireActiveSnapshot(risk, risk.publishedVersionId());
        requireTransition(risk.assignmentRevision() == revision);
        if (assigneeId != null && accounts.lockParticipant(assigneeId).filter(AccountDirectory.Participant::active).isEmpty()) {
            throw new ApiProblem(409, "ASSIGNEE_INACTIVE", "Выберите активного участника.");
        }
        if (Objects.equals(risk.assigneeId(), assigneeId)) {
            return published(member, risk);
        }
        store.changeAssignment(risk, assigneeId, member.id(), calendar.now());
        return published(member, risk(id, false));
    }

    @Transactional
    Published changeGroup(Member member, UUID id, UUID groupId, long revision) {
        Risk risk = risk(id, true);
        requirePublished(risk);
        if (!member.reviewer() && !member.admin()) {
            throw ApiProblem.forbidden();
        }
        requireActiveSnapshot(risk, risk.publishedVersionId());
        requireTransition(risk.groupRevision() == revision);
        if (Objects.equals(risk.groupId(), groupId)) {
            return published(member, risk);
        }
        var lockedGroups = groups.lockForHistory(risk.groupId(), groupId);
        if (groupId != null && !lockedGroups.containsKey(groupId)) {
            throw ApiProblem.invalidRequest();
        }
        String previousName = risk.groupId() == null ? null : lockedGroups.get(risk.groupId()).name();
        String newName = groupId == null ? null : lockedGroups.get(groupId).name();
        store.changeGroup(risk, groupId, member.id(), calendar.now(), previousName, newName);
        return published(member, risk(id, false));
    }

    private RiskVersion requireActiveSnapshot(Risk risk, UUID expected) {
        requirePublished(risk);
        requireTransition(risk.publishedVersionId().equals(expected));
        RiskVersion current = version(risk, expected);
        requireTransition(current.fields().riskState() == RiskState.ACTIVE);
        return current;
    }

    private static void requirePublished(Risk risk) {
        if (!risk.published()) {
            throw ApiProblem.notFound();
        }
    }

    private List<Summary> summaries(boolean archive, String query, UUID assigneeId, boolean needsAssignment,
                                    Category category, UUID groupId, boolean ungrouped) {
        String search = query == null ? "" : query.strip().toLowerCase(Locale.ROOT);
        LocalDate today = calendar.today();
        Collator titles = Collator.getInstance(Locale.forLanguageTag("ru"));
        return store.published(archive, groupId, ungrouped).stream()
                .filter(row -> matches(row.version().fields(), search))
                .filter(row -> assigneeId == null || row.assignee() != null && assigneeId.equals(row.assignee().id()))
                .filter(row -> !needsAssignment || row.assignee() == null || !row.assignee().active())
                .filter(row -> category == null || category == Priority.from(row.version().fields()).category())
                .map(row -> {
                    var version = row.version();
                    var fields = version.fields();
                    return new Summary(version.riskId(), version.id(), fields.title(), row.assignee(), row.group(),
                            fields.likelihood(), fields.impact(), Priority.from(fields), fields.riskState(),
                            Assessment.from(row.assessmentDate(), row.manualReviewDate(), fields.riskState(), today),
                            row.hasOpenDraft());
                })
                .sorted(Comparator.<Summary>comparingInt(item -> item.priority().score()).reversed()
                        .thenComparing(Summary::title, titles).thenComparing(Summary::riskId))
                .toList();
    }

    private static boolean matches(DraftFields fields, String search) {
        return Stream.of(fields.title(), fields.cause(), fields.possibleEvent(), fields.productConsequences())
                .anyMatch(value -> value.toLowerCase(Locale.ROOT).contains(search));
    }

    private List<Proposal> proposals(UUID authorId) {
        return store.proposals(authorId).stream().map(version -> proposal(version, risk(version.riskId(), false))).toList();
    }

    private Proposal proposal(RiskVersion version, Risk risk) {
        return new Proposal(risk.id(), version.id(), version.revision(), version.status(),
                risk.published() ? ProposalKind.EDIT : ProposalKind.FIRST,
                participant(version.authorId()), risk.published() ? version.fields()
                        : new FirstProposalFields(version.fields(), version.proposedGroupId()));
    }

    private Published published(Member member, Risk risk) {
        if (!risk.published()) {
            throw ApiProblem.notFound();
        }
        Snapshot snapshot = snapshot(version(risk, risk.publishedVersionId()));
        var draft = store.draft(risk.id());
        var unblock = draft.filter(version -> member.reviewer() && !version.ownedBy(member))
                .map(version -> new Unblock(version.id(), version.revision(), account(version.authorId()).displayName()));
        return new Published(risk.id(), snapshot, participant(store.firstApprovedAuthor(risk.id())),
                account(risk.assigneeId()), risk.assignmentRevision(),
                risk.groupId() == null ? null : groups.find(risk.groupId()).orElseThrow(), risk.groupRevision(),
                Assessment.from(risk.assessmentDate(), risk.manualReviewDate(), snapshot.riskState(), calendar.today()),
                draft.isPresent(), unblock.orElse(null));
    }

    private Snapshot snapshot(RiskVersion version) {
        DraftFields fields = version.fields();
        return new Snapshot(version.id(), fields.title(), fields.cause(), fields.possibleEvent(),
                fields.productConsequences(), fields.likelihood(), fields.impact(),
                Priority.from(fields), fields.decisionNote(), fields.trackerUrl(), fields.riskState(), fields.closureReason());
    }

    private AccountDirectory.Participant account(UUID id) {
        return id == null ? null : accounts.findParticipant(id).orElseThrow();
    }

    private Participant participant(UUID id) {
        return id == null ? null : new Participant(id, account(id).displayName());
    }

    private Event historyEvent(RiskStore.Event event, Map<UUID, RiskVersion> versions) {
        Participant actor = participant(event.actorId());
        if (event.action() == EventAction.FIELDS_UPDATED) {
            DraftFields previous = versions.get(event.previousVersionId()).fields();
            DraftFields current = versions.get(event.versionId()).fields();
            var changes = current.changesFrom(previous);
            if (!Objects.equals(event.previousManualReviewDate(), event.newManualReviewDate())) {
                changes = Stream.concat(changes.stream(), Stream.of(new FieldChange(
                        "manualReviewDate", event.previousManualReviewDate(), event.newManualReviewDate()))).toList();
            }
            return new FieldsUpdatedEvent(event.versionId(), actor, event.action(),
                    event.occurredAt().withOffsetSameInstant(ZoneOffset.UTC), changes);
        }
        if (event.action().isAssignment()) {
            return new AssignmentEvent(event.versionId(), actor, event.action(), event.occurredAt(),
                    participant(event.previousAssigneeId()), participant(event.newAssigneeId()));
        }
        if (event.action() == EventAction.GROUP_CHANGED) {
            return new GroupEvent(event.versionId(), actor, event.action(), event.occurredAt(),
                    event.previousGroupName(), event.newGroupName());
        }
        var workflow = new WorkflowEvent(event.versionId(), actor, event.action(), event.occurredAt(), event.comment());
        if (event.action() == EventAction.CONFIRM_ASSESSMENT && event.previousManualReviewDate() != null) {
            return new AssessmentConfirmedEvent(workflow, event.previousManualReviewDate());
        }
        return event.firstPublicationWithGroupHistory() ? new FirstPublicationEvent(workflow, event.initialGroupName()) : workflow;
    }

    private Risk risk(UUID id, boolean lock) {
        return store.risk(id, lock).orElseThrow(ApiProblem::notFound);
    }

    private RiskVersion version(Risk risk, UUID id) {
        return store.version(risk.id(), id).orElseThrow(ApiProblem::notFound);
    }

    private static void requireAuthor(RiskVersion version, Member member) {
        if (!version.ownedBy(member)) {
            throw version.visibleTo(member) ? ApiProblem.forbidden() : ApiProblem.notFound();
        }
    }

    private static void requireReviewer(Member member) {
        if (!member.reviewer()) {
            throw ApiProblem.forbidden();
        }
    }

    private static void requireComment(String comment) {
        if (DraftFields.blank(comment)) {
            throw new ApiProblem(400, "INVALID_REQUEST", "Укажите пояснение.");
        }
    }

    private static void checkRevision(RiskVersion version, long revision) {
        requireTransition(version.revision() == revision);
    }

    private static void requireTransition(boolean allowed) {
        if (!allowed) {
            throw conflict();
        }
    }

    private static ApiProblem conflict() {
        return new ApiProblem(409, "RISK_CONFLICT", "Обновите карточку и повторите действие.");
    }
}
