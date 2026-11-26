package uptime.app.risks;

import java.text.Collator;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
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
import uptime.app.accounts.AccountDirectory.Owner;
import uptime.app.http.ApiProblem;
import uptime.app.risks.DraftFields.RiskState;
import uptime.app.risks.RiskResponses.Assessment;
import uptime.app.risks.RiskResponses.Category;
import uptime.app.risks.RiskResponses.Event;
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
import uptime.app.risks.RiskStore.EventAction;
import uptime.app.risks.RiskStore.Risk;
import uptime.app.risks.RiskVersion.Status;

@Service
@Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
class RiskService {
    private final RiskStore store;
    private final AccountDirectory accounts;
    private final RiskCalendar calendar;

    RiskService(RiskStore store, AccountDirectory accounts, RiskCalendar calendar) {
        this.store = store;
        this.accounts = accounts;
        this.calendar = calendar;
    }

    Listing<?> list(Member member, String view, String query, UUID ownerId, Category category) {
        return switch (view) {
            case "active", "archive" -> new Listing<>(view, summaries(view.equals("archive"), query, ownerId, category));
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
        var snapshots = events.stream().filter(event -> event.action() == EventAction.APPROVE)
                .map(event -> snapshot(versions.get(event.versionId()))).toList();
        var visibleEvents = events.stream()
                .filter(event -> event.action() == EventAction.APPROVE || event.action() == EventAction.CONFIRM_ASSESSMENT
                        || versions.get(event.versionId()).visibleTo(member))
                .map(event -> new Event(event.versionId(), participant(event.actorId()), event.action(),
                        event.occurredAt(), event.comment())).toList();
        return new History(id, snapshots, visibleEvents);
    }

    @Transactional
    Proposal create(Member member, JsonNode input) {
        DraftFields fields = DraftFields.initial(member.id()).merge(input);
        requireSelectableOwner(fields.ownerId(), member.id());
        var risk = new Risk(UUID.randomUUID(), null, null);
        store.insertRisk(risk.id());
        return proposal(store.insertDraft(risk.id(), member.id(), fields), risk);
    }

    @Transactional
    Proposal open(Member member, UUID id, UUID expectedSnapshot) {
        Risk risk = risk(id, true);
        RiskVersion current = requireActiveSnapshot(risk, expectedSnapshot);
        if (store.draft(id).isPresent()) {
            throw conflict();
        }
        return proposal(store.insertDraft(id, member.id(), current.fields()), risk);
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
        DraftFields fields = version.fields().merge(input);
        UUID allowedOwner = risk.published() ? version(risk, risk.publishedVersionId()).fields().ownerId() : null;
        if (!Objects.equals(fields.ownerId(), version.fields().ownerId())) {
            requireSelectableOwner(fields.ownerId(), allowedOwner);
        }
        return proposal(fields.equals(version.fields()) ? version : store.save(version, fields), risk);
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
                version.fields().requireComplete();
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
            case CONFIRM_ASSESSMENT -> throw new IllegalArgumentException("Use confirm for a published assessment");
        };
        RiskVersion updated = store.transition(version, target);
        if (target == Status.APPROVED) {
            approve(risk, version, now.toLocalDate());
        }
        store.append(id, versionId, member.id(), action, now, comment);
        return new Identity(updated);
    }

    @Transactional
    Published confirm(Member member, UUID id, UUID expectedSnapshot) {
        requireReviewer(member);
        Risk risk = risk(id, true);
        RiskVersion current = requireActiveSnapshot(risk, expectedSnapshot);
        var now = calendar.now();
        LocalDate date = now.toLocalDate();
        store.publish(id, current.id(), date);
        store.append(id, current.id(), member.id(), EventAction.CONFIRM_ASSESSMENT, now, null);
        return published(member, new Risk(id, current.id(), date));
    }

    private void approve(Risk risk, RiskVersion version, LocalDate today) {
        DraftFields fields = version.fields();
        if (fields.riskState() != RiskState.ACTIVE && DraftFields.blank(fields.closureReason())) {
            throw new ApiProblem(400, "INVALID_REQUEST", "Укажите причину завершения риска.");
        }
        DraftFields previous = risk.published() ? version(risk, risk.publishedVersionId()).fields() : null;
        if (previous == null || !fields.ownerId().equals(previous.ownerId())) {
            if (accounts.lockOwner(fields.ownerId()).filter(Owner::active).isEmpty()) {
                throw new ApiProblem(409, "OWNER_INACTIVE",
                        "Верните предложение автору, чтобы он выбрал активного владельца.");
            }
        }
        boolean reassessed = previous == null || !fields.likelihood().equals(previous.likelihood())
                || !fields.impact().equals(previous.impact());
        store.publish(risk.id(), version.id(), reassessed ? today : risk.assessmentDate());
    }

    private RiskVersion requireActiveSnapshot(Risk risk, UUID expected) {
        if (!risk.published()) {
            throw ApiProblem.notFound();
        }
        requireTransition(risk.publishedVersionId().equals(expected));
        RiskVersion current = version(risk, expected);
        requireTransition(current.fields().riskState() == RiskState.ACTIVE);
        return current;
    }

    private List<Summary> summaries(boolean archive, String query, UUID ownerId, Category category) {
        String search = query == null ? "" : query.strip().toLowerCase(Locale.ROOT);
        LocalDate today = calendar.today();
        Collator titles = Collator.getInstance(Locale.forLanguageTag("ru"));
        return store.published(archive).stream()
                .filter(row -> matches(row.version().fields(), search))
                .filter(row -> ownerId == null || ownerId.equals(row.version().fields().ownerId()))
                .filter(row -> category == null || category == Priority.from(row.version().fields()).category())
                .map(row -> {
                    var version = row.version();
                    var fields = version.fields();
                    return new Summary(version.riskId(), version.id(), fields.title(), account(fields.ownerId()),
                            fields.likelihood(), fields.impact(), Priority.from(fields), fields.riskState(),
                            Assessment.from(row.assessmentDate(), fields.riskState(), today), row.hasOpenDraft());
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
                participant(version.authorId()), version.fields());
    }

    private Published published(Member member, Risk risk) {
        if (!risk.published()) {
            throw ApiProblem.notFound();
        }
        Snapshot snapshot = snapshot(version(risk, risk.publishedVersionId()));
        var draft = store.draft(risk.id());
        var unblock = draft.filter(version -> member.reviewer() && !version.ownedBy(member))
                .map(version -> new Unblock(version.id(), version.revision(), account(version.authorId()).displayName()));
        return new Published(risk.id(), snapshot, Assessment.from(risk.assessmentDate(), snapshot.riskState(),
                calendar.today()), draft.isPresent(), unblock.orElse(null));
    }

    private Snapshot snapshot(RiskVersion version) {
        DraftFields fields = version.fields();
        return new Snapshot(version.id(), fields.title(), fields.cause(), fields.possibleEvent(),
                fields.productConsequences(), account(fields.ownerId()), fields.likelihood(), fields.impact(),
                Priority.from(fields), fields.decisionNote(), fields.trackerUrl(), fields.riskState(), fields.closureReason());
    }

    private Owner account(UUID id) {
        return accounts.findOwner(id).orElseThrow();
    }

    private Participant participant(UUID id) {
        return new Participant(id, account(id).displayName());
    }

    private void requireSelectableOwner(UUID id, UUID allowed) {
        if (id != null && !id.equals(allowed) && accounts.findOwner(id).filter(Owner::active).isEmpty()) {
            throw new ApiProblem(400, "INVALID_REQUEST", "Выберите активного владельца.");
        }
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
