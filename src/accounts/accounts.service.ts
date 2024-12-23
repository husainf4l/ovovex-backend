import { Injectable } from '@nestjs/common';
import { GeneralLedgerService } from 'src/general-ledger/general-ledger.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { parseISO, formatISO } from 'date-fns';
import { $Enums, AccountType } from '@prisma/client';
import { CreateAccountDto } from './dto/CreateAccountDto';

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generalLedgerService: GeneralLedgerService,
  ) {}

  async getAccountStatement(
    accountId: string,
    page = 1,
    limit = 10,
    companyId: string,
    startDate?: string,
    endDate?: string,
  ) {
    const offset = (page - 1) * limit;

    // Parse dates to ISO format
    const startDateISO = startDate ? formatISO(parseISO(startDate)) : undefined;
    const endDateISO = endDate ? formatISO(parseISO(endDate)) : undefined;

    // Fetch account details
    const accountDetails = await this.prisma.account.findUnique({
      where: { id: accountId, companyId: companyId },
    });

    if (!accountDetails) {
      throw new Error(`Account with ID ${accountId} not found`);
    }

    // Base opening balance
    let openingBalance = accountDetails.openingBalance || 0;

    // Calculate opening balance if a startDate is provided
    if (startDateISO) {
      const priorTransactions = await this.prisma.transaction.findMany({
        where: {
          accountId,
          createdAt: { lt: new Date(startDateISO) }, // Transactions before the startDate
        },
      });

      openingBalance += priorTransactions.reduce(
        (balance, transaction) =>
          balance + (transaction.debit || 0) - (transaction.credit || 0),
        0,
      );
    }

    // Fetch transactions within the specified date range
    const transactionFilters: any = { accountId };
    if (startDateISO)
      transactionFilters.createdAt = { gte: new Date(startDateISO) };
    if (endDateISO)
      transactionFilters.createdAt = {
        ...transactionFilters.createdAt,
        lte: new Date(endDateISO),
      };

    const transactions = await this.prisma.transaction.findMany({
      where: transactionFilters,
      include: { journalEntry: true },
      orderBy: { createdAt: 'asc' },
      skip: offset,
      take: limit,
    });

    // Count total transactions for pagination
    const totalTransactions = await this.prisma.transaction.count({
      where: transactionFilters,
    });

    const totalPages = Math.ceil(totalTransactions / limit);

    // Calculate running balance for transactions
    let runningBalance = openingBalance;
    const transactionsWithBalance = transactions.map((transaction) => {
      const { debit, credit } = transaction;
      runningBalance += debit || 0;
      runningBalance -= credit || 0;
      return { ...transaction, runningBalance };
    });

    // Construct the response
    const response = {
      accountDetails: {
        ...accountDetails,
        openingBalance,
      },
      transactions: transactionsWithBalance,
      pagination: {
        totalRecords: totalTransactions,
        currentPage: page,
        totalPages,
      },
      filters: {
        startDate: startDate || null,
        endDate: endDate || null,
      },
      message:
        totalTransactions === 0
          ? 'No transactions found for the given account and date range.'
          : null,
    };

    return response;
  }

  async getCriticalAccounts(companyId: string, codes: string | string[] = []) {
    const codeArray = Array.isArray(codes) ? codes : [codes];

    const accounts = await Promise.all(
      codeArray.map((code) => this.findAccountByCode(code, companyId)),
    );

    if (Array.isArray(codes)) {
      return accounts.reduce((acc, account, idx) => {
        acc[codeArray[idx]] = account;
        return acc;
      }, {});
    }
    return accounts[0];
  }

  async getAccountsUnderCode(code: string, companyId: string) {
    const mainAccount = await this.findAccountByCode(code, companyId);

    if (!mainAccount) {
      throw new Error(
        `Main account with hierarchy code ${code} not found for company ID ${companyId}`,
      );
    }

    return this.prisma.account.findMany({
      where: { parentAccountId: mainAccount.id },
    });
  }

  async getMainAccount(companyId: string) {
    return await this.prisma.account.findMany({
      where: {
        mainAccount: true,
        companyId: companyId,
      },
    });
  }

  async findAccountByCode(code: string, companyId: string) {
    const account = await this.prisma.account.findFirst({
      where: { code: code, companyId: companyId },
    });

    if (!account) {
      throw new Error(
        `Account with hierarchy code ${code} and companyId: ${companyId} not found`,
      );
    }

    return account;
  }

  async createAccount(
    companyId: string,
    data: {
      name: string;
      accountType: $Enums.AccountType;
      openingBalance?: number;
      parentAccountId?: string | null;
      mainAccount: boolean;
    },
  ) {
    const {
      name,
      accountType,
      openingBalance = 0,
      parentAccountId,
      mainAccount,
    } = data;

    if (!mainAccount && !parentAccountId) {
      throw new Error('Parent account ID is required for sub-accounts.');
    }

    let code: string;

    if (mainAccount) {
      const maxMainAccount = await this.prisma.account.findFirst({
        where: { companyId, mainAccount: true },
        orderBy: { code: 'desc' },
      });

      code = maxMainAccount
        ? (parseInt(maxMainAccount.code || '0', 10) + 1).toString()
        : '1';
    } else {
      const parentAccount = await this.prisma.account.findUnique({
        where: { id: parentAccountId },
      });

      if (!parentAccount) {
        throw new Error(`Parent account with ID ${parentAccountId} not found`);
      }

      const maxSubAccount = await this.prisma.account.findFirst({
        where: { companyId, parentAccountId },
        orderBy: { code: 'desc' },
      });

      const subCode = maxSubAccount
        ? (
            parseInt(maxSubAccount.code.split('.').pop() || '0', 10) + 1
          ).toString()
        : '1';

      code = `${parentAccount.code}.${subCode}`;
    }

    const accountData: any = {
      name,
      accountType,
      openingBalance,
      currentBalance: openingBalance,
      mainAccount,
      code,
      companyId,
      parentAccountId: mainAccount ? null : parentAccountId,
    };

    const newAccount = await this.prisma.account.create({
      data: accountData,
    });

    return newAccount;
  }

  async bulkCreate(createAccountDtos: CreateAccountDto[], companyId: string) {
    // Store the results
    const results: any[] = [];

    createAccountDtos.sort((a, b) => a.code.length - b.code.length);

    // Use a transaction for atomicity
    await this.prisma.$transaction(async (prisma) => {
      for (const accountDto of createAccountDtos) {
        // Find or create parent account if parentAccountId is provided
        let parentAccount = null;

        if (accountDto.parentCode) {
          parentAccount = await prisma.account.findUnique({
            where: {
              code_companyId: {
                code: accountDto.parentCode,
                companyId: companyId,
              },
            },
          });

          if (!parentAccount) {
            // Throw an error if parentAccountId is invalid
            throw new Error(
              `Parent account with Code ${accountDto.parentCode} and companyId ${companyId} does not exist.`,
            );
          }
        }

        // Create the account
        const account = await prisma.account.create({
          data: {
            code: accountDto.code,
            parentAccountId: parentAccount ? parentAccount.id : null,
            mainAccount: accountDto.mainAccount,
            name: accountDto.name,
            nameAr: accountDto.nameAr,
            level: accountDto.level,
            accountType: accountDto.accountType,
            companyId: companyId,
          },
        });

        results.push(account);
      }
    });

    return results;
  }

  async delete(accountId: string, companyId: string) {
    await this.prisma.account.delete({
      where: { companyId: companyId, id: accountId },
    });
  }

  async updateCurrentBalance(
    accountId: string,
    debit: number,
    credit: number,
    companyId: string,
  ) {
    const netChange = (debit || 0) - (credit || 0);

    // Update the current account's balance
    await this.prisma.account.update({
      where: { id: accountId },
      data: {
        currentBalance: {
          increment: netChange,
        },
      },
    });

    // Propagate changes up the hierarchy
    let parentAccountId = (
      await this.prisma.account.findUnique({
        where: { id: accountId },
        select: { parentAccountId: true },
      })
    )?.parentAccountId;

    while (parentAccountId) {
      await this.prisma.account.update({
        where: { id: parentAccountId },
        data: {
          currentBalance: {
            increment: netChange,
          },
        },
      });

      parentAccountId = (
        await this.prisma.account.findUnique({
          where: { id: parentAccountId },
          select: { parentAccountId: true },
        })
      )?.parentAccountId;
    }
  }
}
