package uptime.app.risks;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import uptime.app.risks.DraftFields.RiskState;
import uptime.app.risks.RiskResponses.Assessment;

class RiskAssessmentTest {
    @Test
    void changingEitherScoreReassessesWhileOtherEditsPreserveTheCurrentDate() {
        LocalDate previousDate = LocalDate.of(2026, 3, 31);
        LocalDate today = LocalDate.of(2026, 7, 2);
        DraftFields previous = fields(4, 5, null);

        assertEquals(previousDate, Assessment.dateAfterEdit(previousDate, today, previous, fields(4, 5, "Меры")));
        assertEquals(today, Assessment.dateAfterEdit(previousDate, today, previous, fields(6, 5, null)));
        assertEquals(today, Assessment.dateAfterEdit(previousDate, today, previous, fields(4, 6, null)));
    }

    @Test
    void reviewFallsOnTheLastDayOfAShortMonth() {
        LocalDate date = LocalDate.of(2026, 3, 31);
        LocalDate due = LocalDate.of(2026, 6, 30);

        assertEquals(due, Assessment.from(date, RiskState.ACTIVE, due.minusDays(1)).reviewDueDate());
        assertFalse(Assessment.from(date, RiskState.ACTIVE, due.minusDays(1)).reviewRequired());
        assertTrue(Assessment.from(date, RiskState.ACTIVE, due).reviewRequired());
        assertFalse(Assessment.from(date, RiskState.REMOVED, due).reviewRequired());
    }

    private static DraftFields fields(int likelihood, int impact, String note) {
        return new DraftFields("Риск", "Причина", "Событие", "Последствия",
                likelihood, impact, note, null, RiskState.ACTIVE, null);
    }
}
