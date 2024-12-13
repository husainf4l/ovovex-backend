import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class GeneralLedgerService {
    constructor(private prisma: PrismaService) { }





    async updateGeneralLedger(companyId: string): Promise<void> {
        // Step 1: Fetch all accounts and their children (single query)
        const accounts = await this.prisma.account.findMany({
            where: { companyId },
            select: { id: true, parentAccountId: true, openingBalance: true },
            orderBy: { hierarchyCode: 'desc' }, // Start from the deepest accounts
        });

        // Step 2: Fetch all transactions for these accounts (batch query)
        const accountIds = accounts.map((account) => account.id);
        const transactions = await this.prisma.transaction.findMany({
            where: { accountId: { in: accountIds } },
            select: { accountId: true, debit: true, credit: true },
        });

        // Step 3: Calculate balances
        const accountBalances = new Map<string, number>();

        // Initialize account balances with transactions
        for (const account of accounts) {
            const accountTransactions = transactions.filter((t) => t.accountId === account.id);
            const openingBalance = account.openingBalance || 0;
            const transactionBalance = accountTransactions.reduce(
                (sum, t) => sum + (t.debit || 0) - (t.credit || 0),
                openingBalance,
            );

            accountBalances.set(account.id, transactionBalance);
        }

        // Aggregate child balances
        for (const account of accounts) {
            if (account.parentAccountId) {
                const childBalance = accountBalances.get(account.id) || 0;
                accountBalances.set(
                    account.parentAccountId,
                    (accountBalances.get(account.parentAccountId) || 0) + childBalance,
                );
            }
        }

        // Step 4: Update all account balances in bulk
        const updatePromises = Array.from(accountBalances.entries()).map(([accountId, balance]) =>
            this.prisma.account.update({
                where: { id: accountId },
                data: { currentBalance: balance },
            }),
        );

        await Promise.all(updatePromises);

        console.log('General ledger updated successfully');
    }


    private async calculateAccountBalance(account: any, accountBalances: Map<string, number>): Promise<number> {
        // Check if the balance is already calculated
        if (accountBalances.has(account.id)) {
            return accountBalances.get(account.id)!;
        }

        // Get all transactions for this account
        const transactions = await this.prisma.transaction.findMany({
            where: { accountId: account.id },
        });

        // Calculate the balance based on transactions
        let balance = transactions.reduce((sum, transaction) => {
            return sum + (transaction.debit || 0) - (transaction.credit || 0);
        }, account.openingBalance || 0);

        // Add balances of all child accounts
        if (account.children && account.children.length > 0) {
            for (const child of account.children) {
                const childBalance = await this.calculateAccountBalance(child, accountBalances);
                balance += childBalance;
            }
        }

        return balance;
    }


    // Calculate balance dynamically
    async getAccountBalance(accountId: string): Promise<number> {
        // Get all transactions for the account
        const accountTransactions = await this.prisma.transaction.findMany({
            where: { accountId },
        });

        // Calculate the direct balance
        const directBalance = accountTransactions.reduce(
            (sum, t) => sum + (t.debit || 0) - (t.credit || 0),
            0,
        );

        // Fetch child accounts
        const childAccounts = await this.prisma.account.findMany({
            where: { parentAccountId: accountId },
        });

        // Recursively calculate balances for child accounts
        const childBalances = await Promise.all(
            childAccounts.map((child) => this.getAccountBalance(child.id)),
        );

        // Return total balance (direct + child)
        return directBalance + childBalances.reduce((sum, balance) => sum + balance, 0);
    }



    async getStoredBalance(accountId: string): Promise<number> {
        const ledgerEntry = await this.prisma.generalLedger.findUnique({
            where: { accountId },
        });
        return ledgerEntry?.balance || 0;
    }


}
