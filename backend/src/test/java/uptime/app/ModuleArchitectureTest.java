package uptime.app;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.Test;
import uptime.app.accounts.AccountDirectory;

class ModuleArchitectureTest {
    @Test
    void risksCanUseOnlyThePublicAccountsInterface() {
        var classes = new ClassFileImporter().withImportOption(new ImportOption.DoNotIncludeTests())
                .importPackages("uptime.app");

        noClasses().that().resideInAPackage("uptime.app.accounts..")
                .should().dependOnClassesThat().resideInAPackage("uptime.app.risks..")
                .check(classes);
        noClasses().that().resideInAPackage("uptime.app.risks..")
                .should().dependOnClassesThat(DescribedPredicate.describe("are outside the accounts public API",
                        type -> type.getPackageName().startsWith("uptime.app.accounts")
                                && !type.isEquivalentTo(AccountDirectory.class)
                                && !type.isEquivalentTo(AccountDirectory.Member.class)
                                && !type.isEquivalentTo(AccountDirectory.Owner.class)))
                .check(classes);
    }
}
